import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { MembershipApplicationStatus, PaymentMode, Prisma } from "@prisma/client";
import { AccountingClientService } from "../integrations/accounting-client.service";
import { PrismaService } from "../prisma/prisma.service";
import type { StaffJwtRole } from "../auth/staff-jwt.guard";
import {
  blockingFinding,
  evaluateDuplicates,
  firstFlaggedParticipantId,
  resumeApplicationId,
  type DuplicateLookup,
  type ExistingParticipantLite,
} from "./duplicate-engine";
import { createFirebaseMemberAccount, type FirebaseAccountsPort } from "./firebase-accounts";
import { allocateMemberPublicId, maskGivenName, referrerIsApproved } from "./member-id-alloc";
import { draftIpWindow, isRateLimited, lookupIpWindow, submitEmailWindow } from "./rate-limit";
import { derivedApplicationStatus, nextStatusAfterLifecycle } from "./status-sync";
import { publicCreateForExistingApplication } from "./existing-draft-policy";
import { canAccessMembershipApplications, membershipScreenshotPath } from "./staff-access";
import { referrerConflictMessage } from "./referrer-rules";
import { generateUploadKey, validateScreenshotBytes } from "./screenshot";
import { generateResumeToken, hashResumeToken, isResumeTokenExpired, resumeTokenExpiresAt, tokensMatch, continueUrl } from "./tokens";
import { verifyTurnstile } from "./turnstile";
import { isUniqueViolation } from "./unique-violation";
import {
  composeFullName,
  DPA_CONSENT_VERSION_DEFAULT,
  DRAFT_TTL_DAYS,
  formatDobIso,
  formatMailingAddress,
  MEMBERSHIP_FEE_DEFAULT,
  MIN_SHARE_CAPITAL,
  normalizeEmail,
  normalizePhMobile,
  normalizeTinDigits,
  parseIsoDateOnly,
  parsePaymentMode,
  validateDraftField,
  validateGcashRef,
  validateShareCapital,
  validateSubmitPayload,
} from "./validators";

const OPEN_STATUSES: MembershipApplicationStatus[] = [
  MembershipApplicationStatus.DRAFT,
  MembershipApplicationStatus.SUBMITTED,
];

const PATCH_ALLOW = new Set([
  "fullName",
  "firstName",
  "middleName",
  "lastName",
  "dob",
  "gender",
  "mobile",
  "tinNo",
  "residentialAddress",
  "referredByParticipantId",
  "referralQuery",
  "shareCapitalAmount",
  "shareCapitalPaid",
  "membershipFeePaid",
  "paymentMode",
  "gcashRefNo",
]);

export const MEMBERSHIP_FIREBASE = "MEMBERSHIP_FIREBASE";

@Injectable()
export class MembershipService {
  private readonly logger = new Logger(MembershipService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounting: AccountingClientService,
    @Optional() @Inject(MEMBERSHIP_FIREBASE) private readonly firebase: FirebaseAccountsPort | null = null,
  ) {}

  private publicAppUrl(): string {
    return String(process.env.PUBLIC_APP_URL ?? process.env.VITE_APP_URL ?? "https://b2ccoop.com").replace(/\/$/, "");
  }

  private async consumeRateLimit(window: { bucketKey: string; windowStart: Date; limit: number }): Promise<void> {
    const row = await this.prisma.membershipRateLimit.upsert({
      where: { bucketKey_windowStart: { bucketKey: window.bucketKey, windowStart: window.windowStart } },
      create: { bucketKey: window.bucketKey, windowStart: window.windowStart, count: 1 },
      update: { count: { increment: 1 } },
    });
    if (isRateLimited(row.count - 1, window.limit)) {
      throw new BadRequestException("Too many requests. Please try again later.");
    }
  }

  private async requireTurnstile(token: string | undefined, ip: string) {
    const v = await verifyTurnstile(token, ip);
    if (!v.ok) throw new BadRequestException(v.message ?? "Captcha verification failed.");
  }

  private async duplicateLookup(): Promise<DuplicateLookup> {
    return {
      findParticipantByEmail: async (email) => this.toLite(await this.prisma.participant.findUnique({ where: { email } })),
      findParticipantByMobile: async (mobile) =>
        this.toLite(await this.prisma.participant.findFirst({ where: { phone: mobile } })),
      findParticipantByTin: async (tin) =>
        this.toLite(await this.prisma.participant.findFirst({ where: { tinNo: tin } })),
      findParticipantByNameDob: async (fullName, dobIso) => {
        const rows = await this.prisma.participant.findMany({
          where: { dob: dobIso },
          take: 20,
        });
        const hit = rows.find((r) => r.fullName.trim().replace(/\s+/g, " ").toLowerCase() === fullName);
        return this.toLite(hit ?? null);
      },
      findOpenApplicationByEmail: async (email) => {
        const row = await this.prisma.membershipApplication.findFirst({
          where: { email, status: { in: OPEN_STATUSES } },
          select: { id: true, email: true, status: true },
        });
        return row;
      },
      firebaseEmailExists: async (email) => {
        if (!this.firebase) return false;
        const u = await this.firebase.lookupByEmail(email);
        return Boolean(u);
      },
    };
  }

  private toLite(p: {
    id: string;
    email: string;
    phone: string | null;
    tinNo: string | null;
    fullName: string;
    dob: string | Date | null;
    boardApprovedAt: Date | string | null;
    legacyPioneerImport: boolean;
  } | null): ExistingParticipantLite | null {
    if (!p) return null;
    return {
      id: p.id,
      email: p.email,
      phone: p.phone,
      tinNo: p.tinNo,
      fullName: p.fullName,
      dob: p.dob,
      boardApprovedAt: p.boardApprovedAt,
      legacyPioneerImport: p.legacyPioneerImport,
    };
  }

  private publicApplication(row: {
    id: string;
    status: MembershipApplicationStatus;
    fullName: string | null;
    firstName: string | null;
    middleName: string | null;
    lastName: string | null;
    dob: Date | null;
    gender: string | null;
    email: string;
    mobile: string | null;
    tinNo: string | null;
    residentialAddress: Prisma.JsonValue | null;
    referredByParticipantId: string | null;
    shareCapitalAmount: Prisma.Decimal;
    shareCapitalPaid: boolean;
    membershipFeeAmount: Prisma.Decimal;
    membershipFeePaid: boolean;
    paymentMode: PaymentMode | null;
    gcashRefNo: string | null;
    gcashScreenshotKey: string | null;
    possibleDuplicateOfId: string | null;
    submittedAt: Date | null;
    participantId: string | null;
    dpaConsentAt: Date | null;
  }) {
    return {
      id: row.id,
      status: row.status,
      fullName: row.fullName,
      firstName: row.firstName,
      middleName: row.middleName,
      lastName: row.lastName,
      dob: row.dob ? formatDobIso(row.dob) : null,
      gender: row.gender,
      email: row.email,
      mobile: row.mobile,
      tinNo: row.tinNo,
      residentialAddress: row.residentialAddress,
      referredByParticipantId: row.referredByParticipantId,
      shareCapitalAmount: Number(row.shareCapitalAmount),
      shareCapitalPaid: row.shareCapitalPaid,
      membershipFeeAmount: Number(row.membershipFeeAmount),
      membershipFeePaid: row.membershipFeePaid,
      paymentMode: row.paymentMode,
      gcashRefNo: row.gcashRefNo,
      hasGcashScreenshot: Boolean(row.gcashScreenshotKey),
      submittedAt: row.submittedAt,
      participantId: row.participantId,
      dpaConsentAt: row.dpaConsentAt,
    };
  }

  private async loadAuthorized(id: string, token: string) {
    const row = await this.prisma.membershipApplication.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Application not found");
    if (!tokensMatch(token, row.resumeTokenHash) || isResumeTokenExpired(row.resumeTokenExpiresAt)) {
      throw new UnauthorizedException("Resume token is invalid.");
    }
    return row;
  }

  async createDraft(input: {
    email: string;
    mobile?: string;
    dpaConsent: boolean;
    captchaToken?: string;
    referralCode?: string;
    ip: string;
    userAgent?: string;
  }) {
    await this.requireTurnstile(input.captchaToken, input.ip);
    await this.consumeRateLimit(draftIpWindow(input.ip));
    if (!input.dpaConsent) {
      throw new BadRequestException("Data Privacy Act consent is required.");
    }
    const email = normalizeEmail(input.email);
    if (!email) throw new BadRequestException("email is required");
    const mobile = input.mobile ? normalizePhMobile(input.mobile) : null;

    const existing = await this.prisma.membershipApplication.findFirst({
      where: { email, status: { in: OPEN_STATUSES } },
    });
    if (existing) {
      const policy = publicCreateForExistingApplication(existing.status);
      return { checkEmail: true as const, message: policy.message };
    }

    let referredByParticipantId: string | null = null;
    if (input.referralCode) {
      referredByParticipantId = await this.resolveReferrer(input.referralCode, {
        applicantEmail: email,
        applicantMobile: mobile,
      });
    }

    const token = generateResumeToken();
    const created = await this.prisma.membershipApplication.create({
      data: {
        email,
        mobile,
        dpaConsentAt: new Date(),
        dpaConsentVersion: process.env.DPA_CONSENT_VERSION?.trim() || DPA_CONSENT_VERSION_DEFAULT,
        consentIp: input.ip.slice(0, 64),
        userAgent: (input.userAgent ?? "").slice(0, 500),
        resumeTokenHash: hashResumeToken(token),
        resumeTokenExpiresAt: resumeTokenExpiresAt(),
        referredByParticipantId,
        shareCapitalAmount: MIN_SHARE_CAPITAL,
        membershipFeeAmount: MEMBERSHIP_FEE_DEFAULT,
      },
    });
    return {
      ...this.publicApplication(created),
      resumeToken: token,
      continueUrl: continueUrl(this.publicAppUrl(), token),
      resumed: false,
    };
  }

  async getDraft(id: string, token: string) {
    const row = await this.loadAuthorized(id, token);
    return this.publicApplication(row);
  }

  async patchDraft(id: string, token: string, fields: Record<string, unknown>) {
    const row = await this.loadAuthorized(id, token);
    if (row.status !== MembershipApplicationStatus.DRAFT && row.status !== MembershipApplicationStatus.SUBMITTED) {
      throw new BadRequestException("This application can no longer be edited.");
    }
    const data: Prisma.MembershipApplicationUpdateInput = {};
    const warnings: { field: string; message: string }[] = [];

    for (const [key, value] of Object.entries(fields)) {
      if (!PATCH_ALLOW.has(key)) continue;
      const issue = validateDraftField(key === "referralQuery" ? "fullName" : key, value);
      if (issue && key !== "referralQuery" && value != null && String(value).trim() !== "") {
        warnings.push(issue);
      }
      switch (key) {
        case "fullName":
        case "firstName":
        case "middleName":
        case "lastName":
        case "gender":
          data[key] = value == null ? null : String(value).trim().slice(0, 200);
          break;
        case "dob": {
          const d = parseIsoDateOnly(value as string);
          data.dob = d;
          break;
        }
        case "mobile":
          data.mobile = value ? normalizePhMobile(String(value)) : null;
          break;
        case "tinNo":
          data.tinNo = value ? normalizeTinDigits(String(value)) || null : null;
          break;
        case "residentialAddress":
          data.residentialAddress = value && typeof value === "object" ? (value as Prisma.InputJsonValue) : Prisma.JsonNull;
          break;
        case "referredByParticipantId":
          if (value) {
            const resolved = await this.requireApprovedReferrer(String(value), {
              applicantEmail: row.email,
              applicantMobile: row.mobile,
              applicantParticipantId: row.participantId,
            });
            data.referredByParticipantId = resolved;
          } else {
            data.referredByParticipantId = null;
          }
          break;
        case "referralQuery":
          if (value) {
            const resolved = await this.resolveReferrer(String(value), {
              applicantEmail: row.email,
              applicantMobile: row.mobile,
              applicantParticipantId: row.participantId,
            });
            if (resolved) data.referredByParticipantId = resolved;
          }
          break;
        case "shareCapitalAmount": {
          const n = validateShareCapital(value);
          if (n != null) data.shareCapitalAmount = new Prisma.Decimal(n);
          break;
        }
        case "shareCapitalPaid":
          data.shareCapitalPaid = value === true;
          break;
        case "membershipFeePaid":
          data.membershipFeePaid = value === true;
          break;
        case "paymentMode":
          data.paymentMode = parsePaymentMode(value);
          break;
        case "gcashRefNo":
          data.gcashRefNo = value ? validateGcashRef(String(value)) : null;
          break;
        default:
          break;
      }
    }

    const first = data.firstName as string | undefined;
    const last = data.lastName as string | undefined;
    const middle = data.middleName as string | undefined;
    if ((first || last) && data.fullName == null) {
      data.fullName = composeFullName(first ?? row.firstName, middle ?? row.middleName, last ?? row.lastName, row.fullName);
    }

    const paidChanged =
      data.shareCapitalPaid !== undefined ||
      data.membershipFeePaid !== undefined ||
      data.gcashRefNo !== undefined ||
      data.paymentMode !== undefined;
    if (paidChanged && (data.shareCapitalPaid === true || data.membershipFeePaid === true || row.shareCapitalPaid || row.membershipFeePaid)) {
      data.paymentDeclaredAt = new Date();
    }

    const lookup = await this.duplicateLookup();
    const soft = await evaluateDuplicates(
      {
        email: row.email,
        mobile: (data.mobile as string | null | undefined) ?? row.mobile,
        tinNo: (data.tinNo as string | null | undefined) ?? row.tinNo,
        fullName: (data.fullName as string | undefined) ?? row.fullName,
        dob: (data.dob as Date | undefined) ?? row.dob,
        excludeApplicationId: row.id,
      },
      lookup,
    );
    const flagId = firstFlaggedParticipantId(soft);
    if (flagId) data.possibleDuplicateOfId = flagId;

    const updated = await this.prisma.membershipApplication.update({ where: { id: row.id }, data });
    if (paidChanged && updated.status !== MembershipApplicationStatus.DRAFT) {
      await this.notifyTreasurers(updated);
    }
    return { application: this.publicApplication(updated), warnings, duplicateFlags: soft.filter((f) => f.action === "flag") };
  }

  async submit(id: string, token: string, input: { captchaToken?: string; ip: string }) {
    await this.requireTurnstile(input.captchaToken, input.ip);
    const row = await this.loadAuthorized(id, token);
    if (row.status !== MembershipApplicationStatus.DRAFT && row.status !== MembershipApplicationStatus.SUBMITTED) {
      throw new BadRequestException("This application was already processed.");
    }
    await this.consumeRateLimit(submitEmailWindow(row.email));

    const fullName = composeFullName(row.firstName, row.middleName, row.lastName, row.fullName);
    const issues = validateSubmitPayload({
      fullName,
      firstName: row.firstName,
      lastName: row.lastName,
      dob: row.dob ?? "",
      gender: row.gender ?? "",
      email: row.email,
      mobile: row.mobile ?? "",
      tinNo: row.tinNo,
      residentialAddress: (row.residentialAddress as {
        street?: string;
        barangay?: string;
        cityMunicipality?: string;
        province?: string;
        zip?: string;
      } | null) ?? null,
      shareCapitalAmount: Number(row.shareCapitalAmount),
      shareCapitalPaid: row.shareCapitalPaid,
      membershipFeePaid: row.membershipFeePaid,
      paymentMode: row.paymentMode,
      gcashRefNo: row.gcashRefNo,
      dpaConsentAt: row.dpaConsentAt,
    });
    if (issues.length) {
      throw new BadRequestException({ message: "Please fix the highlighted fields.", issues });
    }

    if (row.referredByParticipantId) {
      await this.requireApprovedReferrer(row.referredByParticipantId, {
        applicantEmail: row.email,
        applicantMobile: row.mobile,
        applicantParticipantId: row.participantId,
      });
    }

    const lookup = await this.duplicateLookup();
    const dups = await evaluateDuplicates(
      {
        email: row.email,
        mobile: row.mobile,
        tinNo: row.tinNo,
        fullName,
        dob: row.dob,
        excludeApplicationId: row.id,
      },
      lookup,
    );
    const resumeId = resumeApplicationId(dups);
    if (resumeId && resumeId !== row.id) {
      throw new ConflictException({ message: "An open application already exists for this email.", applicationId: resumeId });
    }
    const block = blockingFinding(dups);
    if (block) {
      if (block.action === "reclaim") {
        throw new ConflictException({ message: block.message, code: "LEGACY_RECLAIM", participantId: block.participantId });
      }
      throw new ConflictException({ message: block.message, code: "DUPLICATE", kind: block.kind });
    }

    const dob = parseIsoDateOnly(row.dob)!;
    const dobIso = formatDobIso(dob);
    const mobile = normalizePhMobile(row.mobile)!;
    const tin = row.tinNo ? normalizeTinDigits(row.tinNo) : null;
    const mailing = formatMailingAddress(row.residentialAddress as never);

    if (!this.firebase) {
      throw new BadRequestException("Firebase Admin is not configured; cannot create a login on submit.");
    }

    const existingParticipant = await this.prisma.participant.findUnique({ where: { email: row.email } });
    const newToken = generateResumeToken();
    let result: { participant: { id: string; memberIdNo: string | null; firebaseUid: string | null }; application: typeof row } | null = null;
    let lastUniqueError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      const memberIdNo =
        existingParticipant?.memberIdNo ||
        (await allocateMemberPublicId({
          fullName,
          firstName: row.firstName,
          lastName: row.lastName,
          dob: dobIso,
          exists: async (candidate) => {
            const hit = await this.prisma.participant.findFirst({ where: { memberIdNo: candidate } });
            return Boolean(hit);
          },
        }));
      try {
        result = await this.prisma.$transaction(async (tx) => {
          const participant = existingParticipant
            ? await tx.participant.update({
                where: { id: existingParticipant.id },
                data: {
                  fullName,
                  phone: mobile,
                  dob: dobIso,
                  gender: String(row.gender).trim(),
                  tinNo: tin,
                  mailingAddress: mailing || existingParticipant.mailingAddress,
                  memberIdNo: existingParticipant.memberIdNo || memberIdNo,
                  referredByParticipantId: existingParticipant.referredByParticipantId ?? row.referredByParticipantId,
                  tinMissingFlaggedAt: tin ? null : new Date(),
                  registrationSource: existingParticipant.registrationSource ?? "online_form",
                },
              })
            : await tx.participant.create({
                data: {
                  fullName,
                  email: row.email,
                  phone: mobile,
                  dob: dobIso,
                  gender: String(row.gender).trim(),
                  tinNo: tin,
                  mailingAddress: mailing || null,
                  memberIdNo,
                  referredByParticipantId: row.referredByParticipantId,
                  tinMissingFlaggedAt: tin ? null : new Date(),
                  registrationSource: "online_form",
                },
              });

          const application = await tx.membershipApplication.update({
            where: { id: row.id },
            data: {
              status: MembershipApplicationStatus.SUBMITTED,
              participantId: participant.id,
              fullName,
              submittedAt: new Date(),
              resumeTokenHash: hashResumeToken(newToken),
              resumeTokenExpiresAt: resumeTokenExpiresAt(),
              possibleDuplicateOfId: firstFlaggedParticipantId(dups),
              paymentDeclaredAt: row.shareCapitalPaid || row.membershipFeePaid ? row.paymentDeclaredAt ?? new Date() : row.paymentDeclaredAt,
            },
          });
          return { participant, application };
        });
        break;
      } catch (e) {
        lastUniqueError = e;
        if (!isUniqueViolation(e) || existingParticipant?.memberIdNo) throw e;
      }
    }
    if (!result) {
      throw lastUniqueError instanceof Error ? lastUniqueError : new Error("Could not allocate a unique member ID.");
    }

    let passwordEmailSent = false;
    let firebaseUid = result.participant.firebaseUid ?? existingParticipant?.firebaseUid ?? null;
    if (firebaseUid) {
      const created = await createFirebaseMemberAccount(row.email, fullName, this.firebase);
      if (created.uid !== firebaseUid) {
        throw new ConflictException("Already registered — sign in or reset password");
      }
      passwordEmailSent = created.passwordEmailSent;
    } else {
      const created = await createFirebaseMemberAccount(row.email, fullName, this.firebase);
      const other = await this.prisma.participant.findFirst({
        where: { firebaseUid: created.uid, NOT: { id: result.participant.id } },
      });
      if (other) {
        if (created.created) {
          await this.firebase.deleteUser?.(created.uid).catch((e) =>
            this.logger.warn(`Firebase compensate delete skipped: ${e instanceof Error ? e.message : e}`),
          );
        }
        throw new ConflictException("Already registered — sign in or reset password");
      }
      try {
        await this.prisma.participant.update({
          where: { id: result.participant.id },
          data: { firebaseUid: created.uid },
        });
        firebaseUid = created.uid;
        passwordEmailSent = created.passwordEmailSent;
      } catch (e) {
        if (created.created) {
          await this.firebase.deleteUser?.(created.uid).catch((err) =>
            this.logger.warn(`Firebase compensate delete skipped: ${err instanceof Error ? err.message : err}`),
          );
        }
        throw e;
      }
    }

    await this.notifyTreasurers(result.application);

    return {
      application: this.publicApplication(result.application),
      resumeToken: newToken,
      memberIdNo: result.participant.memberIdNo,
      participantId: result.participant.id,
      needsTin: !tin,
      passwordEmailSent,
    };
  }

  async resendResumeLink(id: string, token: string) {
    await this.loadAuthorized(id, token);
    return { ok: true, continueUrl: continueUrl(this.publicAppUrl(), token) };
  }

  async claimResume(token: string) {
    const plain = String(token ?? "").trim();
    if (!plain) throw new UnauthorizedException("Resume token is invalid.");
    const hash = hashResumeToken(plain);
    const byLive = await this.prisma.membershipApplication.findUnique({ where: { resumeTokenHash: hash } });
    if (byLive) {
      if (isResumeTokenExpired(byLive.resumeTokenExpiresAt)) {
        throw new UnauthorizedException("This continue link is invalid or expired.");
      }
      return { ...this.publicApplication(byLive), resumeToken: plain };
    }
    const byPending = await this.prisma.membershipApplication.findFirst({ where: { pendingResumeTokenHash: hash } });
    if (!byPending || isResumeTokenExpired(byPending.pendingResumeTokenExpiresAt)) {
      throw new UnauthorizedException("This continue link is invalid or expired.");
    }
    const next = generateResumeToken();
    const updated = await this.prisma.membershipApplication.update({
      where: { id: byPending.id },
      data: {
        resumeTokenHash: hashResumeToken(next),
        resumeTokenExpiresAt: resumeTokenExpiresAt(),
        pendingResumeTokenHash: null,
        pendingResumeTokenExpiresAt: null,
      },
    });
    return { ...this.publicApplication(updated), resumeToken: next };
  }

  async lookupReferrer(q: string, ip: string, applicant?: { email?: string; mobile?: string; participantId?: string | null }) {
    await this.consumeRateLimit(lookupIpWindow(ip));
    const query = String(q ?? "").trim();
    if (query.length < 2) return { results: [] as { memberIdNo: string; displayName: string }[] };

    const resolved = await this.resolveReferrer(query, {
      applicantEmail: applicant?.email,
      applicantMobile: applicant?.mobile,
      applicantParticipantId: applicant?.participantId,
    });
    if (resolved) {
      const p = await this.prisma.participant.findUnique({ where: { id: resolved } });
      if (p && referrerIsApproved(p)) {
        return { results: [{ memberIdNo: p.memberIdNo ?? p.id, displayName: maskGivenName(p.fullName) }] };
      }
    }

    const rows = await this.prisma.participant.findMany({
      where: {
        boardApprovedAt: { not: null },
        OR: [
          { fullName: { contains: query, mode: "insensitive" } },
          { memberIdNo: { contains: query, mode: "insensitive" } },
          { callsign: { contains: query.toLowerCase(), mode: "insensitive" } },
        ],
      },
      take: 8,
      select: { fullName: true, memberIdNo: true, id: true, email: true, phone: true },
    });
    return {
      results: rows
        .filter((r) => r.memberIdNo)
        .filter((r) => !referrerConflictMessage({
          referrerId: r.id,
          referrerEmail: r.email,
          referrerPhone: r.phone,
          applicantEmail: applicant?.email,
          applicantMobile: applicant?.mobile,
          applicantParticipantId: applicant?.participantId,
        }))
        .map((r) => ({ memberIdNo: r.memberIdNo as string, displayName: maskGivenName(r.fullName) })),
    };
  }

  async attachScreenshot(id: string, token: string, bytes: Uint8Array | Buffer) {
    const row = await this.loadAuthorized(id, token);
    const valid = validateScreenshotBytes(bytes);
    if (!valid.ok) throw new BadRequestException(valid.message);
    const key = generateUploadKey(id, valid.mime);
    const storedKey =
      process.env.NODE_ENV === "test" || String(process.env.MEMBERSHIP_ALLOW_MOCK_UPLOADS ?? "").trim() === "1"
        ? `mock:${key}`
        : key;
    const updated = await this.prisma.membershipApplication.update({
      where: { id: row.id },
      data: { gcashScreenshotKey: storedKey, paymentDeclaredAt: new Date() },
    });
    if (updated.status !== MembershipApplicationStatus.DRAFT) {
      await this.notifyTreasurers(updated);
    }
    return this.publicApplication(updated);
  }

  async adminGetScreenshot(id: string, staff: { role: StaffJwtRole }) {
    if (!canAccessMembershipApplications(staff.role)) {
      throw new ForbiddenException("Only Treasurer, Secretary, or Superuser may view GCash screenshots.");
    }
    const row = await this.prisma.membershipApplication.findUnique({
      where: { id },
      select: { gcashScreenshotKey: true },
    });
    if (!row?.gcashScreenshotKey) {
      throw new NotFoundException("No screenshot");
    }
    throw new NotFoundException("Screenshot not available");
  }

  async expireDrafts(now = new Date()) {
    const cutoff = new Date(now.getTime() - DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000);
    const expired = await this.prisma.membershipApplication.updateMany({
      where: { status: MembershipApplicationStatus.DRAFT, createdAt: { lt: cutoff } },
      data: { status: MembershipApplicationStatus.EXPIRED },
    });
    const stale = await this.prisma.membershipApplication.findMany({
      where: { status: MembershipApplicationStatus.EXPIRED, createdAt: { lt: cutoff } },
      select: { id: true },
      take: 200,
    });
    if (stale.length) {
      await this.prisma.membershipApplication.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    }
    return { expired: expired.count, purged: stale.length };
  }

  async sendTreasurerReminders() {
    const rows = await this.prisma.membershipApplication.findMany({
      where: {
        status: MembershipApplicationStatus.SUBMITTED,
        OR: [{ shareCapitalPaid: true }, { membershipFeePaid: true }],
        paymentConfirmedAt: null,
      },
      take: 100,
    });
    let sent = 0;
    for (const row of rows) {
      await this.notifyTreasurers(row);
      sent += 1;
    }
    return { reminded: sent };
  }

  async adminList(staff: { role: StaffJwtRole }, query: { status?: string; q?: string }) {
    if (!canAccessMembershipApplications(staff.role)) {
      throw new ForbiddenException("Only Treasurer, Secretary, or Superuser may list online applications.");
    }
    const where: Prisma.MembershipApplicationWhereInput = {};
    if (query.status) {
      where.status = query.status as MembershipApplicationStatus;
    }
    if (query.q) {
      const q = query.q.trim();
      where.OR = [
        { email: { contains: q, mode: "insensitive" } },
        { fullName: { contains: q, mode: "insensitive" } },
        { mobile: { contains: q } },
        { gcashRefNo: { contains: q } },
      ];
    }
    const rows = await this.prisma.membershipApplication.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: 200,
      include: { participant: { select: { memberIdNo: true, initialFeesPaidAt: true, boardApprovedAt: true } } },
    });
    const pendingWhere: Prisma.MembershipApplicationWhereInput = {
      status: MembershipApplicationStatus.SUBMITTED,
      OR: [{ shareCapitalPaid: true }, { membershipFeePaid: true }],
      paymentConfirmedAt: null,
    };
    const pendingPayment = await this.prisma.membershipApplication.count({ where: pendingWhere });
    const noticed = await this.prisma.membershipApplication.count({
      where: { ...pendingWhere, treasurerNotifiedAt: { not: null } },
    });
    return {
      applications: rows.map((r) => ({
        ...this.publicApplication(r),
        memberIdNo: r.participant?.memberIdNo ?? null,
        initialFeesPaidAt: r.participant?.initialFeesPaidAt ?? null,
        boardApprovedAt: r.participant?.boardApprovedAt ?? null,
        flaggedPossibleDuplicate: Boolean(r.possibleDuplicateOfId),
        screenshotUrl: r.gcashScreenshotKey ? membershipScreenshotPath(r.id) : null,
      })),
      inbox: { paymentsToConfirm: pendingPayment, treasurerNotice: noticed > 0 },
    };
  }

  async adminConfirmPayment(
    id: string,
    staff: { sub: string; role: StaffJwtRole },
    body: { receiptNo?: string },
  ) {
    if (!["superuser", "admin", "treasurer"].includes(staff.role)) {
      throw new ForbiddenException("Only Treasurer (or Admin / Superuser) can confirm payment.");
    }
    const row = await this.prisma.membershipApplication.findUnique({ where: { id } });
    if (!row?.participantId) throw new NotFoundException("Submitted application not found");

    const before = await this.prisma.participant.findUnique({ where: { id: row.participantId } });
    if (!before) throw new NotFoundException("Participant not found");

    const updatedParticipant = await this.prisma.participant.update({
      where: { id: before.id },
      data: { initialFeesPaidAt: before.initialFeesPaidAt ?? new Date() },
    });

    const application = await this.prisma.membershipApplication.update({
      where: { id: row.id },
      data: {
        status: MembershipApplicationStatus.PAYMENT_CONFIRMED,
        paymentConfirmedAt: new Date(),
        paymentConfirmedById: staff.sub,
        receiptNo: body.receiptNo?.trim() || row.receiptNo,
      },
    });

    let accountingInitialFees: { ok: boolean; created: boolean; error?: string } | null = null;
    if (!before.initialFeesPaidAt) {
      accountingInitialFees = await this.accounting.postInitialFeesPaidAwait({
        participantId: before.id,
        memberIdNo: updatedParticipant.memberIdNo,
        email: before.email,
        fullName: before.fullName,
      });
    }
    return { application: this.publicApplication(application), accountingInitialFees };
  }

  async adminReject(id: string, staff: { sub: string; role: StaffJwtRole }, reason: string) {
    if (!["superuser", "secretary"].includes(staff.role)) {
      throw new ForbiddenException("Only the Secretary (or Superuser) may reject an application.");
    }
    const why = String(reason ?? "").trim();
    if (!why) throw new BadRequestException("rejectionReason is required");
    const row = await this.prisma.membershipApplication.update({
      where: { id },
      data: {
        status: MembershipApplicationStatus.REJECTED,
        rejectedAt: new Date(),
        rejectionReason: why.slice(0, 1000),
      },
    });
    return this.publicApplication(row);
  }

  async adminPatchReferrer(id: string, staff: { sub: string; role: StaffJwtRole }, referrerId: string | null) {
    if (!["superuser", "secretary"].includes(staff.role)) {
      throw new ForbiddenException("Only the Secretary (or Superuser) may correct the referrer.");
    }
    const row = await this.prisma.membershipApplication.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Application not found");
    if (row.status === MembershipApplicationStatus.APPROVED) {
      throw new BadRequestException("Referrer can only be corrected before approval.");
    }
    const resolved = referrerId
      ? await this.requireApprovedReferrer(referrerId, {
          applicantEmail: row.email,
          applicantMobile: row.mobile,
          applicantParticipantId: row.participantId,
        })
      : null;
    const updated = await this.prisma.membershipApplication.update({
      where: { id },
      data: { referredByParticipantId: resolved },
    });
    if (updated.participantId) {
      await this.prisma.participant.update({
        where: { id: updated.participantId },
        data: { referredByParticipantId: resolved },
      });
    }
    return this.publicApplication(updated);
  }

  async syncFromParticipant(participantId: string) {
    const p = await this.prisma.participant.findUnique({ where: { id: participantId } });
    if (!p) return;
    const app = await this.prisma.membershipApplication.findUnique({ where: { participantId } });
    if (!app) return;
    const derived = derivedApplicationStatus(p);
    const next = nextStatusAfterLifecycle(app.status, derived);
    if (next !== app.status) {
      await this.prisma.membershipApplication.update({ where: { id: app.id }, data: { status: next } });
    }
  }

  private async requireApprovedReferrer(
    idOrQuery: string,
    applicant?: { applicantEmail?: string | null; applicantMobile?: string | null; applicantParticipantId?: string | null },
  ): Promise<string> {
    const resolved = await this.resolveReferrer(idOrQuery, applicant);
    if (!resolved) throw new BadRequestException("Referred by must be an approved member.");
    return resolved;
  }

  async resolveReferrer(
    raw: string,
    applicant?: { applicantEmail?: string | null; applicantMobile?: string | null; applicantParticipantId?: string | null },
  ): Promise<string | null> {
    const q = String(raw ?? "").trim();
    if (!q) return null;

    let candidate: { id: string; email?: string | null; phone?: string | null; boardApprovedAt?: Date | string | null } | null = null;

    const pioneer = q.match(/^PIONEER-([a-fA-F0-9]{8})$/i);
    if (pioneer?.[1]) {
      const suffix = pioneer[1].toUpperCase();
      const rows = await this.prisma.$queryRaw<Array<{ id: string; boardApprovedAt: Date | null; email: string; phone: string | null }>>`
        SELECT id, "boardApprovedAt", email, phone FROM "Participant"
        WHERE "firebaseUid" IS NOT NULL
          AND UPPER(RIGHT(REPLACE("firebaseUid", '-', ''), 8)) = ${suffix}
        LIMIT 2
      `;
      if (rows.length === 1 && referrerIsApproved(rows[0]!)) candidate = rows[0]!;
    } else {
      candidate = await this.prisma.participant.findFirst({
        where: {
          OR: [{ id: q }, { memberIdNo: q }, { callsign: q.toLowerCase() }],
          boardApprovedAt: { not: null },
        },
        select: { id: true, email: true, phone: true, boardApprovedAt: true },
      });
    }
    if (!candidate) return null;
    const conflict = referrerConflictMessage({
      referrerId: candidate.id,
      referrerEmail: candidate.email,
      referrerPhone: candidate.phone,
      applicantEmail: applicant?.applicantEmail,
      applicantMobile: applicant?.applicantMobile,
      applicantParticipantId: applicant?.applicantParticipantId,
    });
    if (conflict) throw new BadRequestException(conflict);
    return candidate.id;
  }

  private async notifyTreasurers(row: { id: string }) {
    await this.prisma.membershipApplication.update({
      where: { id: row.id },
      data: { treasurerNotifiedAt: new Date() },
    });
  }
}
