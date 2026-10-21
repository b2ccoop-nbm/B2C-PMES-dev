import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { AuthService } from "../auth/auth.service";
import { AccountingClientService } from "../integrations/accounting-client.service";
import { PrismaService } from "../prisma/prisma.service";
import { CreateLoiDto } from "./dto/create-loi.dto";
import { CreatePmesDto } from "./dto/create-pmes.dto";
import { SubmitFullProfileDto } from "./dto/submit-full-profile.dto";
import type { ImportLegacyPioneerRowDto } from "./dto/import-legacy-pioneers.dto";
import type { PioneerEligibilityDto } from "./dto/pioneer-eligibility.dto";
import { UpdateParticipantMembershipDto } from "./dto/update-participant-membership.dto";
import { RecordMembershipPaymentDto } from "./dto/record-membership-payment.dto";
import type { AdminUpdateParticipantDto } from "./dto/admin-update-participant.dto";
import type { UpdateMemberBasicProfileDto } from "./dto/update-member-basic-profile.dto";
import {
  computeAlternatePublicHandle,
  normalizeLastNameKey,
  validateAndNormalizeCallsignInput,
} from "./callsign.util";
import {
  asObject,
  deriveFromMemberProfile,
  normalizeProfileDobForParticipantColumn,
  parseFullProfileEnvelope,
} from "./member-profile.extract";
import {
  buildMemberPublicId,
  cohortYYFromDob,
  initialsFromFirstLast,
  initialsFromFullName,
  parseYearFromDob,
} from "./member-public-id";
import { StaffRole, type LoiSubmission, type Participant, type PmesRecord } from "@prisma/client";
import type { StaffJwtRole } from "../auth/staff-jwt.guard";
import { BOD_DIRECTOR_SEATS, BOD_MAJORITY_APPROVALS } from "./board-workflow.constants";
import { assertPmesPassedForSecretary, forcePmesOverrideAudit } from "../membership/pmes-gate";
import { derivedApplicationStatus, nextStatusAfterLifecycle } from "../membership/status-sync";
import { normalizeTinDigits as normalizeTinDigitsMembership, isValidTin } from "../membership/validators";

export type MembershipStage =
  | "NO_PARTICIPANT"
  | "PMES_NOT_PASSED"
  | "AWAITING_LOI"
  | "AWAITING_PAYMENT"
  | "AWAITING_BOD_VOTE"
  | "AWAITING_SECRETARY_RESOLUTION"
  | "AWAITING_FULL_PROFILE"
  | "FULL_MEMBER";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const REGISTRY_PLACEHOLDER_SUFFIX = "@b2c-registry.example.com";

/** Matches `frontend/src/lib/referralTiers.js` PIONEER_POINTS_PER_JOIN */
const REFERRAL_PIONEER_POINTS_PER_JOIN = 50;

function startOfCurrentUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/** Synthetic sign-in emails from legacy roster import (see `buildSynthetic…` in this service). */
function isPlaceholderRegistryLoginEmail(email: string): boolean {
  return normalizeEmail(email).endsWith(REGISTRY_PLACEHOLDER_SUFFIX);
}

function contactEmailFromProfile(profile: unknown): string | null {
  const root = asObject(profile);
  const c = root ? asObject(root.contact) : null;
  const raw = c && typeof c.emailAddress === "string" ? c.emailAddress.trim() : "";
  return raw || null;
}

function digitsOnly(s: string | null | undefined): string {
  return String(s ?? "").replace(/\D/g, "");
}

/** Legacy pioneer import stored PH TIN in `memberIdNo` for reclaim — blocks real B2C public ID until moved to `tinNo`. */
function isNineDigitTinPlaceholderInMemberIdSlot(legacyPioneerImport: boolean, memberIdNo: string | null | undefined): boolean {
  if (!legacyPioneerImport) return false;
  const d = digitsOnly(memberIdNo);
  return d.length === 9 && !/^B2C-/i.test(String(memberIdNo ?? "").trim());
}

/** Non-digits removed; if more than 9 digits, drop last 3 repeatedly (sheet TINs often end in 000). */
function normalizeTinDigits(raw: string | undefined): string {
  let d = digitsOnly(raw);
  while (d.length > 9) {
    d = d.slice(0, -3);
  }
  return d;
}

/**
 * Single `Participant.fullName` from import row. Prefer explicit `fullName` when the sheet has it.
 * Otherwise join **firstName**, **middleName**, **lastName** (given-name-first order for one string),
 * even though roster columns are often listed Last / First / Middle.
 */
function composeLegacyFullName(row: ImportLegacyPioneerRowDto): string | null {
  const direct = row.fullName?.trim();
  if (direct) return direct;
  const f = row.firstName?.trim() ?? "";
  const m = row.middleName?.trim() ?? "";
  const l = row.lastName?.trim() ?? "";
  if (!f && !l) return null;
  return [f, m, l].filter(Boolean).join(" ").trim() || null;
}

/** Lowercase + collapse spaces — compare roster fullName to reclaim form. */
function normalizeFullNameForMatch(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveLegacyGender(row: ImportLegacyPioneerRowDto): string | null {
  const g = row.gender?.trim() || row.sexGender?.trim();
  if (g) return g;
  const sh = row.sheet;
  if (sh && typeof sh === "object") {
    const raw = (sh as Record<string, unknown>)["Sex/Gender"] ?? (sh as Record<string, unknown>).sexGender;
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return null;
}

function synthesizeLegacyImportEmail(row: ImportLegacyPioneerRowDto): string {
  const fromRow = row.email?.trim();
  if (fromRow) return normalizeEmail(fromRow);
  const tin = normalizeTinDigits(row.tinNo);
  if (tin.length >= 6) return normalizeEmail(`tin-${tin}@b2c-registry.example.com`);
  return normalizeEmail(`legacy-${randomUUID()}@b2c-registry.example.com`);
}

function buildLegacyMailingAddress(row: ImportLegacyPioneerRowDto): string | null {
  const parts = [
    row.street?.trim(),
    row.barangay?.trim(),
    row.cityMunicipality?.trim(),
    row.province?.trim(),
  ].filter(Boolean);
  if (parts.length === 0) {
    const sh = row.sheet;
    if (sh && typeof sh === "object") {
      const o = sh as Record<string, unknown>;
      const p = [o.Street, o.Barangay, o["City/ Municipality"], o.Province]
        .map((x) => (typeof x === "string" ? x.trim() : ""))
        .filter(Boolean);
      if (p.length) return p.join(", ");
    }
    return null;
  }
  return parts.join(", ");
}

function buildRegistryImportSnapshot(
  row: ImportLegacyPioneerRowDto,
  meta: { resolvedEmail: string; dobPlaceholder: boolean },
): Prisma.InputJsonValue {
  const flat: Record<string, unknown> = {
    email: row.email ?? null,
    fullName: row.fullName ?? null,
    lastName: row.lastName ?? null,
    firstName: row.firstName ?? null,
    middleName: row.middleName ?? null,
    phone: row.phone ?? null,
    dob: row.dob ?? null,
    gender: row.gender ?? null,
    sexGender: row.sexGender ?? null,
    registryTimestamp: row.registryTimestamp ?? null,
    civilStatus: row.civilStatus ?? null,
    street: row.street ?? null,
    barangay: row.barangay ?? null,
    cityMunicipality: row.cityMunicipality ?? null,
    province: row.province ?? null,
    tinNo: normalizeTinDigits(row.tinNo) || null,
    tinNoAsImported: row.tinNo?.trim() || null,
    initialSubscriptionAmount: row.initialSubscriptionAmount ?? null,
    paidUpShareAmount: row.paidUpShareAmount ?? null,
    religion: row.religion ?? null,
    resolvedEmail: meta.resolvedEmail,
    dobPlaceholder: meta.dobPlaceholder,
    importedAt: new Date().toISOString(),
  };
  const sheet = row.sheet && typeof row.sheet === "object" ? { ...(row.sheet as object) } : {};
  const merged = { ...sheet, ...flat };
  for (const k of Object.keys(merged)) {
    const v = merged[k as keyof typeof merged];
    if (v === undefined || v === null || v === "") {
      delete merged[k as keyof typeof merged];
    }
  }
  return merged as Prisma.InputJsonValue;
}

type ParticipantWithRelations = Participant & {
  pmesRecords: PmesRecord[];
  loiSubmission: LoiSubmission | null;
};

export type MemberRegistryRow = {
  participantId: string;
  fullName: string;
  email: string;
  phone: string;
  dob: string;
  gender: string;
  mailingAddress: string | null;
  civilStatus: string | null;
  memberIdNo: string | null;
  tinNo: string | null;
  /** Present when the member has linked Firebase (password reset applies). */
  firebaseUid: string | null;
  loiAddress: string | null;
  fullProfileCompletedAt: string | null;
  /** Account creation time (ISO). */
  createdAt: string;
  /** `StaffUser.role` when a staff login exists for the same email as this member. */
  staffRole: string | null;
  /** Human-readable officer/admin label for the registry table. */
  staffPosition: string | null;
  /** Preloaded roster import; unclaimed when no Firebase uid. */
  legacyPioneerImport: boolean;
};

@Injectable()
export class PmesService {
  private readonly logger = new Logger(PmesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly accounting: AccountingClientService,
  ) {}

  /** Upsert participant by email, append PMES attempt; returns flat shape for the existing UI. */
  async submitSession(dto: CreatePmesDto) {
    const email = normalizeEmail(dto.email);
    const { participant, record } = await this.prisma.$transaction(async (tx) => {
      const participantRow = await tx.participant.upsert({
        where: { email },
        create: {
          fullName: dto.fullName.trim(),
          email,
          phone: dto.phone.trim(),
          dob: dto.dob.trim(),
          gender: dto.gender.trim(),
        },
        update: {
          fullName: dto.fullName.trim(),
          phone: dto.phone.trim(),
          dob: dto.dob.trim(),
          gender: dto.gender.trim(),
        },
      });
      const recordRow = await tx.pmesRecord.create({
        data: {
          participantId: participantRow.id,
          score: dto.score,
          passed: dto.passed,
        },
      });
      return { participant: participantRow, record: recordRow };
    });

    return this.flattenRecord(participant, record);
  }

  async submitLoi(dto: CreateLoiDto) {
    const email = normalizeEmail(dto.email);
    const participant = await this.prisma.participant.findUnique({ where: { email } });
    if (!participant) {
      throw new NotFoundException("Participant not found for this email");
    }
    await this.prisma.loiSubmission.upsert({
      where: { participantId: participant.id },
      create: {
        participantId: participant.id,
        address: dto.address.trim(),
        occupation: dto.occupation.trim(),
        employer: dto.employer.trim(),
        initialCapital: dto.initialCapital,
      },
      update: {
        address: dto.address.trim(),
        occupation: dto.occupation.trim(),
        employer: dto.employer.trim(),
        initialCapital: dto.initialCapital,
      },
    });
    return { success: true };
  }

  async findCertificateRecord(emailRaw: string, dob: string) {
    const email = normalizeEmail(emailRaw);
    const participant = await this.prisma.participant.findUnique({
      where: { email },
      include: { pmesRecords: { orderBy: { timestamp: "desc" } } },
    });
    if (!participant || participant.pmesRecords.length === 0) {
      return null;
    }
    const passed = participant.pmesRecords.find((r) => r.passed);
    const record = passed ?? participant.pmesRecords[0];
    return this.flattenRecord(participant, record);
  }

  /**
   * Master list is driven by `PmesRecord` rows. Legacy founder imports normally create a passing
   * attempt, but older or hand-edited data can leave `legacyPioneerImport` participants with no
   * PMES row — they would be invisible here. Backfill one passing record so they appear like imports.
   */
  /** Legacy roster members are listed in Member Registry / Pipeline, not the PMES master list. */
  private async ensurePmesRowsForLegacyFoundersWithoutAttempt() {
    return;
  }

  async listAllPmesForAdmin() {
    await this.ensurePmesRowsForLegacyFoundersWithoutAttempt();
    const rows = await this.prisma.pmesRecord.findMany({
      where: { participant: { legacyPioneerImport: false } },
      include: { participant: true },
      orderBy: { timestamp: "desc" },
    });
    return rows.map(({ id, score, passed, participant, timestamp }) => ({
      id,
      score,
      passed,
      fullName: participant.fullName,
      email: participant.email,
      phone: participant.phone,
      dob: participant.dob,
      gender: participant.gender,
      legacyPioneerImport: participant.legacyPioneerImport,
      timestamp: timestamp.toISOString(),
    }));
  }

  /** Superuser-only: remove one PMES attempt row (does not delete the participant). */
  async deletePmesRecordById(recordId: string) {
    const id = String(recordId ?? "").trim();
    if (!id) {
      throw new BadRequestException("record id is required");
    }
    try {
      await this.prisma.pmesRecord.delete({ where: { id } });
    } catch (e) {
      const code = e && typeof e === "object" && "code" in e ? String((e as { code?: string }).code) : "";
      if (code === "P2025") {
        throw new NotFoundException("PMES record not found");
      }
      throw e;
    }
    return { deleted: true, id };
  }

  /**
   * Superuser only: permanently remove a participant and all related PMES attempts and LOI.
   * Use to drop duplicate/stale pipeline rows (e.g. second email) without touching other participants.
   */
  async deleteParticipantById(participantId: string) {
    const id = String(participantId ?? "").trim();
    if (!id) {
      throw new BadRequestException("participant id is required");
    }

    const exists = await this.prisma.participant.findUnique({ where: { id }, select: { id: true } });
    if (!exists) {
      throw new NotFoundException("Participant not found");
    }

    await this.prisma.$transaction([
      this.prisma.pmesRecord.deleteMany({ where: { participantId: id } }),
      this.prisma.loiSubmission.deleteMany({ where: { participantId: id } }),
      this.prisma.participant.delete({ where: { id } }),
    ]);

    return { deleted: true, participantId: id };
  }

  /**
   * Superuser only: replace auto-generated `memberIdNo` (wrong cohort, typo, etc.).
   * Keeps `memberProfileSnapshot` / `fullProfileJson` personal.memberIdNo in sync when present.
   */
  async superuserSetParticipantMemberId(participantId: string, memberIdNoRaw: string) {
    const id = String(participantId ?? "").trim();
    if (!id) throw new BadRequestException("participant id is required");

    const normalized = String(memberIdNoRaw ?? "").trim();
    if (!normalized.length) {
      throw new BadRequestException("memberIdNo is required");
    }
    if (/\s/.test(normalized)) {
      throw new BadRequestException("memberIdNo must not contain whitespace");
    }

    const p = await this.prisma.participant.findUnique({
      where: { id },
      include: {
        pmesRecords: { orderBy: { timestamp: "desc" } },
        loiSubmission: true,
      },
    });
    if (!p) throw new NotFoundException("Participant not found");

    if (normalized.localeCompare(String(p.memberIdNo ?? ""), undefined, { sensitivity: "accent" }) === 0) {
      return { success: true as const, memberIdNo: normalized, lifecycle: this.toLifecyclePayload(p) };
    }

    const clashMember = await this.prisma.participant.findFirst({
      where: {
        id: { not: id },
        memberIdNo: { equals: normalized, mode: "insensitive" },
      },
      select: { id: true },
    });
    if (clashMember) {
      throw new ConflictException("Another participant already uses this member ID.");
    }

    const lower = normalized.toLowerCase();
    const clashCallsign = await this.prisma.participant.findFirst({
      where: {
        id: { not: id },
        callsign: lower,
      },
      select: { id: true },
    });
    if (clashCallsign) {
      throw new ConflictException("This value matches another member’s callsign; choose a different member ID.");
    }

    let nextSnapshot: Prisma.InputJsonValue | undefined;
    if (p.memberProfileSnapshot != null) {
      const merged = this.mergeMemberIdIntoProfileJson(p.memberProfileSnapshot as unknown, normalized);
      if (asObject(merged)) {
        nextSnapshot = merged as Prisma.InputJsonValue;
      }
    }

    let nextFullProfileJson: string | undefined;
    const env = parseFullProfileEnvelope(p.fullProfileJson);
    if (env && env.profile !== undefined) {
      const mergedProfile = this.mergeMemberIdIntoProfileJson(env.profile, normalized);
      nextFullProfileJson = JSON.stringify({ ...env, profile: mergedProfile });
    }

    const updated = await this.prisma.participant.update({
      where: { id },
      data: {
        memberIdNo: normalized,
        memberProfileConcurrencyStamp: { increment: 1 },
        ...(nextSnapshot !== undefined ? { memberProfileSnapshot: nextSnapshot } : {}),
        ...(nextFullProfileJson !== undefined ? { fullProfileJson: nextFullProfileJson } : {}),
      },
      include: {
        pmesRecords: { orderBy: { timestamp: "desc" } },
        loiSubmission: true,
      },
    });

    return {
      success: true as const,
      memberIdNo: normalized,
      lifecycle: this.toLifecyclePayload(updated),
    };
  }

  private mergeMemberIdIntoProfileJson(profile: unknown, memberIdNo: string): unknown {
    const root = asObject(profile);
    if (!root) return profile;
    const personal = asObject(root.personal) ?? {};
    personal.memberIdNo = memberIdNo;
    return { ...root, personal };
  }

  private mergeContactEmailIntoProfileJson(profile: unknown, emailAddress: string): unknown {
    const root = asObject(profile);
    if (!root) return profile;
    const contact = asObject(root.contact) ?? {};
    return { ...root, contact: { ...contact, emailAddress } };
  }

  /** Member-facing: derive cooperative membership pipeline from DB */
  async getMembershipLifecycle(emailRaw: string) {
    const email = normalizeEmail(emailRaw);
    const participant = await this.prisma.participant.findUnique({
      where: { email },
      include: {
        pmesRecords: { orderBy: { timestamp: "desc" } },
        loiSubmission: true,
      },
    });
    if (!participant) {
      const referralRewards = {
        successfulJoinCount: 0,
        pioneerPoints: 0,
        invitesThisMonth: 0,
      };
      return {
        participantId: null as string | null,
        email,
        stage: "NO_PARTICIPANT" as const,
        pmEsPassed: false,
        loiSubmitted: false,
        initialFeesPaid: false,
        boardApproved: false,
        fullProfileCompleted: false,
        canAccessFullMemberPortal: false,
        profileRecordVersion: null as number | null,
        memberIdNo: null as string | null,
        callsign: null as string | null,
        alternatePublicHandle: null as string | null,
        memberIdIsProvisional: false,
        registrationFullName: null as string | null,
        registrationDob: null as string | null,
        registrationGender: null as string | null,
        registrationPhone: null as string | null,
        staffRole: null as string | null,
        staffPosition: null as string | null,
        referralRewards,
        bodApproveVoteCount: 0,
        bodMajorityReached: false,
        bodMajorityRequired: BOD_MAJORITY_APPROVALS,
        bodDirectorSeats: BOD_DIRECTOR_SEATS,
        boardResolutionNo: null as string | null,
        needsTin: false,
        tinMissingFlaggedAt: null as Date | null,
      };
    }
    const withMemberId = await this.ensureMemberPublicId(participant);
    const yesVotes = await this.prisma.boardApprovalVote.count({
      where: { participantId: withMemberId.id, approve: true },
    });
    const staffLogin = await this.prisma.staffUser.findUnique({
      where: { email },
      select: { role: true },
    });
    const life = this.toLifecyclePayload(withMemberId, yesVotes);
    const referralRewards = await this.referralRewardsForParticipant(withMemberId.id);
    return {
      ...life,
      staffRole: staffLogin?.role ?? null,
      staffPosition: staffLogin ? this.formatStaffPositionLabel(staffLogin.role) : null,
      referralRewards,
    };
  }

  async updateParticipantMembership(
    dto: UpdateParticipantMembershipDto,
    staff: { sub: string; role: StaffJwtRole },
  ) {
    const p = await this.prisma.participant.findUnique({ where: { id: dto.participantId } });
    if (!p) throw new NotFoundException("Participant not found");

    if (dto.initialFeesPaid !== true && dto.boardApproved !== true) {
      throw new BadRequestException("Set initialFeesPaid and/or boardApproved to true to record a step.");
    }

    if (dto.initialFeesPaid === true) {
      const ok = ["superuser", "admin", "treasurer"].includes(staff.role);
      if (!ok) {
        throw new ForbiddenException("Only Treasurer (or Admin / Superuser) can confirm fee payment.");
      }
    }

    if (dto.boardApproved === true) {
      if (staff.role !== "superuser") {
        throw new ForbiddenException(
          "Use Secretary confirmation to record Board approval with a resolution number. Superuser may override here for legacy support.",
        );
      }
      await this.assertPmesGate(dto.participantId, staff.role, dto.forcePmesOverride === true);
    }

    const data: {
      initialFeesPaidAt?: Date | null;
      boardApprovedAt?: Date | null;
    } = {};

    if (dto.initialFeesPaid === true) {
      data.initialFeesPaidAt = new Date();
    }
    if (dto.boardApproved === true) {
      data.boardApprovedAt = new Date();
    }

    const updated = await this.prisma.participant.update({
      where: { id: dto.participantId },
      data,
      include: {
        pmesRecords: { orderBy: { timestamp: "desc" } },
        loiSubmission: true,
      },
    });

    let accountingInitialFees: { ok: boolean; created: boolean; error?: string } | null = null;
    if (dto.initialFeesPaid === true && !p.initialFeesPaidAt) {
      accountingInitialFees = await this.accounting.postInitialFeesPaidAwait({
        participantId: p.id,
        memberIdNo: p.memberIdNo,
        email: p.email,
        fullName: p.fullName,
      });
    }

    const votes = await this.prisma.boardApprovalVote.count({
      where: { participantId: dto.participantId, approve: true },
    });
    await this.syncOnlineApplicationStatus(dto.participantId);
    const life = this.toLifecyclePayload(updated, votes);
    return accountingInitialFees
      ? { ...life, accountingInitialFees }
      : life;
  }

  async recordMembershipPayment(
    dto: RecordMembershipPaymentDto,
    staff: { sub: string; role: StaffJwtRole },
  ) {
    if (!["superuser", "admin", "treasurer"].includes(staff.role)) {
      throw new ForbiddenException("Only Treasurer (or Admin / Superuser) can record membership payments.");
    }

    const p = await this.prisma.participant.findUnique({ where: { id: dto.participantId } });
    if (!p) throw new NotFoundException("Participant not found");
    if (!p.initialFeesPaidAt) {
      throw new BadRequestException("Confirm initial fees before recording recurring payments.");
    }

    const accountingPayment = await this.accounting.postMembershipPaymentAwait({
      participantId: p.id,
      paymentType: dto.paymentType,
      period: dto.period,
      memberIdNo: p.memberIdNo,
      email: p.email,
      fullName: p.fullName,
    });

    if (!accountingPayment.ok) {
      throw new BadRequestException(accountingPayment.error ?? "Accounting post failed");
    }

    return { ok: true, accountingPayment };
  }

  /** Board-eligible staff (directors, Chairperson, Vice Chairperson, GM, Superuser) cast votes; majority sets `bodMajorityReachedAt`. */
  async recordBodVote(participantId: string, approve: boolean, staff: { sub: string; role: StaffJwtRole }) {
    const actor = await this.prisma.staffUser.findUnique({ where: { id: staff.sub } });
    if (!actor) throw new ForbiddenException("Staff account not found");

    const bodVoterDbRoles: StaffRole[] = [
      StaffRole.SUPERUSER,
      StaffRole.BOARD_DIRECTOR,
      StaffRole.CHAIRMAN,
      StaffRole.VICE_CHAIRMAN,
      StaffRole.GENERAL_MANAGER,
    ];
    if (!bodVoterDbRoles.includes(actor.role)) {
      throw new ForbiddenException(
        "Only Board-designated officers (directors, Chairperson, Vice Chairperson, General manager) or Superuser may cast BOD votes.",
      );
    }

    const p = await this.prisma.participant.findUnique({ where: { id: participantId } });
    if (!p) throw new NotFoundException("Participant not found");
    if (!p.initialFeesPaidAt) {
      throw new BadRequestException(
        "Treasurer must confirm fee payment before the Board can record votes on this application.",
      );
    }
    if (p.boardApprovedAt) {
      throw new BadRequestException("Board approval is already recorded for this member.");
    }

    await this.prisma.boardApprovalVote.upsert({
      where: {
        participantId_staffUserId: { participantId, staffUserId: staff.sub },
      },
      create: { participantId, staffUserId: staff.sub, approve },
      update: { approve },
    });

    await this.syncBodMajorityFlag(participantId);

    const updated = await this.prisma.participant.findUnique({
      where: { id: participantId },
      include: {
        pmesRecords: { orderBy: { timestamp: "desc" } },
        loiSubmission: true,
      },
    });
    if (!updated) throw new NotFoundException("Participant not found");
    await this.syncOnlineApplicationStatus(participantId);
    const votes = await this.prisma.boardApprovalVote.count({
      where: { participantId, approve: true },
    });
    return this.toLifecyclePayload(updated, votes);
  }

  /** Secretary issues the next Board Resolution number and sets final `boardApprovedAt`. */
  async recordSecretaryBoardConfirmation(
    participantId: string,
    staff: { sub: string; role: StaffJwtRole },
    opts?: { forcePmesOverride?: boolean },
  ) {
    if (staff.role !== "superuser" && staff.role !== "secretary") {
      throw new ForbiddenException("Only the Secretary (or Superuser) may issue the Board resolution.");
    }
    const actor = await this.prisma.staffUser.findUnique({ where: { id: staff.sub } });
    if (!actor) throw new ForbiddenException("Staff account not found");
    if (staff.role === "secretary" && actor.role !== StaffRole.SECRETARY) {
      throw new ForbiddenException("Your account is not the Secretary.");
    }

    const p = await this.prisma.participant.findUnique({ where: { id: participantId } });
    if (!p) throw new NotFoundException("Participant not found");
    if (!p.initialFeesPaidAt) {
      throw new BadRequestException(
        "Treasurer must confirm fee payment before a Board Resolution can be issued.",
      );
    }
    if (p.boardApprovedAt) {
      throw new BadRequestException("Board approval is already recorded.");
    }
    if (!p.bodMajorityReachedAt) {
      throw new BadRequestException(
        `BOD majority (${BOD_MAJORITY_APPROVALS} approving votes) is required before the Secretary can issue a resolution.`,
      );
    }

    await this.assertPmesGate(participantId, staff.role, opts?.forcePmesOverride === true);

    const resolutionNo = await this.allocateNextBoardResolutionNo();

    const updated = await this.prisma.participant.update({
      where: { id: participantId },
      data: {
        boardResolutionNo: resolutionNo,
        boardApprovedAt: new Date(),
      },
      include: {
        pmesRecords: { orderBy: { timestamp: "desc" } },
        loiSubmission: true,
      },
    });
    const votes = await this.prisma.boardApprovalVote.count({
      where: { participantId, approve: true },
    });
    await this.syncOnlineApplicationStatus(participantId);
    return this.toLifecyclePayload(updated, votes);
  }

  private async assertPmesGate(participantId: string, actorRole: StaffJwtRole, force: boolean) {
    const passed = await this.prisma.pmesRecord.findFirst({
      where: { participantId, passed: true },
      select: { id: true },
    });
    const gate = assertPmesPassedForSecretary(Boolean(passed), { force, actorRole });
    if (!gate.ok) {
      throw new BadRequestException(gate.message);
    }
    const audit = forcePmesOverrideAudit({
      participantId,
      actorRole,
      force,
      pmesPassed: Boolean(passed),
    });
    if (audit.shouldLog) {
      this.logger.warn(audit.message);
    }
  }

  private async syncOnlineApplicationStatus(participantId: string) {
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

  private async syncBodMajorityFlag(participantId: string) {
    const p = await this.prisma.participant.findUnique({ where: { id: participantId } });
    if (!p || p.boardApprovedAt) return;
    if (!p.initialFeesPaidAt) {
      await this.prisma.participant.update({
        where: { id: participantId },
        data: { bodMajorityReachedAt: null },
      });
      return;
    }
    const yes = await this.prisma.boardApprovalVote.count({
      where: { participantId, approve: true },
    });
    const reach = yes >= BOD_MAJORITY_APPROVALS;
    await this.prisma.participant.update({
      where: { id: participantId },
      data: {
        bodMajorityReachedAt: reach ? (p.bodMajorityReachedAt ?? new Date()) : null,
      },
    });
  }

  /** Format `APR-2026-001` — sequence resets each calendar month (NNN within month-year). */
  private async allocateNextBoardResolutionNo(): Promise<string> {
    const MONTHS = [
      "JAN",
      "FEB",
      "MAR",
      "APR",
      "MAY",
      "JUN",
      "JUL",
      "AUG",
      "SEP",
      "OCT",
      "NOV",
      "DEC",
    ] as const;
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const label = `${MONTHS[month - 1]}-${year}-`;

    const row = await this.prisma.$transaction(async (tx) => {
      return tx.boardResolutionCounter.upsert({
        where: {
          year_month: { year, month },
        },
        create: { year, month, lastSeq: 1 },
        update: { lastSeq: { increment: 1 } },
      });
    });

    return `${label}${String(row.lastSeq).padStart(3, "0")}`;
  }

  async submitFullProfile(dto: SubmitFullProfileDto) {
    const email = normalizeEmail(dto.email);
    const participant = await this.prisma.participant.findUnique({
      where: { email },
      include: {
        pmesRecords: { orderBy: { timestamp: "desc" } },
        loiSubmission: true,
      },
    });
    if (!participant) throw new NotFoundException("Participant not found");
    if (!participant.boardApprovedAt) {
      throw new BadRequestException("Board approval is required before submitting the full member profile.");
    }
    if (participant.fullProfileCompletedAt) {
      throw new BadRequestException("Full profile was already submitted.");
    }

    const expectedV = dto.expectedProfileRecordVersion;
    if (
      expectedV !== undefined &&
      expectedV !== null &&
      participant.memberProfileConcurrencyStamp !== expectedV
    ) {
      throw new ConflictException(
        "This profile was updated elsewhere (another tab, session, or staff). Refresh the page, then submit again.",
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(dto.profileJson) as unknown;
    } catch {
      throw new BadRequestException("profileJson must be valid JSON.");
    }

    const afterTinAndProvisional = await this.ensureMemberPublicId(participant, parsed);
    const withMemberId = await this.assignPermanentMemberIdForFullProfileSubmit(afterTinAndProvisional, parsed);
    const root = asObject(parsed);
    if (root && withMemberId.memberIdNo?.trim()) {
      const personal = asObject(root.personal) ?? {};
      personal.memberIdNo = withMemberId.memberIdNo.trim();
      root.personal = personal;
      parsed = root;
    }

    const personalForDob = asObject(asObject(parsed)?.personal);
    const birthDateRaw =
      personalForDob && typeof personalForDob.birthDate === "string" ? personalForDob.birthDate.trim() : "";
    const dobFromProfile = birthDateRaw ? normalizeProfileDobForParticipantColumn(birthDateRaw) : undefined;

    const rootForCallsign = asObject(parsed);
    let callsignOut: string | null = null;
    const personalForCallsign = rootForCallsign ? asObject(rootForCallsign.personal) : null;
    const lastNameRaw =
      personalForCallsign && typeof personalForCallsign.lastName === "string"
        ? personalForCallsign.lastName
        : "";
    const slug = normalizeLastNameKey(lastNameRaw);
    const rawCall =
      personalForCallsign && typeof personalForCallsign.callsign === "string"
        ? personalForCallsign.callsign.trim()
        : "";
    if (rawCall) {
      callsignOut = validateAndNormalizeCallsignInput(rawCall);
      await this.assertCallsignAvailable(callsignOut, withMemberId.id);
    }
    if (rootForCallsign && personalForCallsign) {
      if (callsignOut) {
        personalForCallsign.callsign = callsignOut;
      } else {
        delete personalForCallsign.callsign;
      }
      rootForCallsign.personal = personalForCallsign;
      parsed = rootForCallsign;
    }

    const payload = {
      formVersion: "b2c-membership-v1",
      profile: parsed,
      sheetFileName: dto.sheetFileName ?? "",
      notes: dto.notes ?? "",
      submittedAt: new Date().toISOString(),
    };

    const derived = deriveFromMemberProfile(parsed);

    const contactEmail = contactEmailFromProfile(parsed);
    const previousLoginEmail = participant.email;
    const uid = participant.firebaseUid;
    let migratedLoginEmail: string | null = null;
    if (
      uid &&
      contactEmail &&
      (participant.legacyPioneerImport || isPlaceholderRegistryLoginEmail(participant.email)) &&
      normalizeEmail(contactEmail) !== normalizeEmail(previousLoginEmail)
    ) {
      migratedLoginEmail = await this.auth.updateFirebasePrimaryEmail(uid, contactEmail);
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        let lastNameKey = participant.lastNameKey;
        let lastNameSeq = participant.lastNameSeq;
        if (slug && lastNameSeq == null) {
          const row = await tx.lastNameCounter.upsert({
            where: { lastNameKey: slug },
            create: { lastNameKey: slug, nextSeq: 1 },
            update: { nextSeq: { increment: 1 } },
          });
          lastNameKey = slug;
          lastNameSeq = row.nextSeq;
        }

        const stampWhere =
          expectedV !== undefined && expectedV !== null ? { memberProfileConcurrencyStamp: expectedV } : {};

        const updated = await tx.participant.updateMany({
          where: { id: withMemberId.id, ...stampWhere },
          data: {
            fullProfileCompletedAt: new Date(),
            fullProfileJson: JSON.stringify(payload),
            memberProfileSnapshot: parsed as Prisma.InputJsonValue,
            mailingAddress: derived.mailingAddress.trim() || null,
            civilStatus: derived.civilStatus.trim() || null,
            memberIdNo: withMemberId.memberIdNo?.trim() || derived.memberIdNo.trim() || null,
            ...(dobFromProfile ? { dob: dobFromProfile } : {}),
            ...(derived.phone.trim() ? { phone: derived.phone.trim().slice(0, 64) } : {}),
            ...(derived.displayFullName.trim() ? { fullName: derived.displayFullName.trim().slice(0, 500) } : {}),
            ...(derived.sexGender.trim() ? { gender: derived.sexGender.trim().slice(0, 32) } : {}),
            callsign: callsignOut,
            lastNameKey,
            lastNameSeq,
            memberProfileConcurrencyStamp: { increment: 1 },
            ...(migratedLoginEmail ? { email: migratedLoginEmail } : {}),
          },
        });
        if (updated.count === 0) {
          throw new ConflictException(
            "This profile was updated elsewhere (another tab, session, or staff). Refresh the page, then submit again.",
          );
        }
      });
    } catch (err) {
      if (migratedLoginEmail && uid) {
        try {
          await this.auth.updateFirebasePrimaryEmail(uid, previousLoginEmail);
        } catch (rollbackErr) {
          this.logger.error(
            "Failed to revert Firebase primary email after full-profile DB failure; participant may need a manual Auth email fix.",
            rollbackErr instanceof Error ? rollbackErr.stack : String(rollbackErr),
          );
        }
      }
      throw err;
    }

    await this.maybeCreditReferralJoin(withMemberId.id);

    return {
      success: true,
      ...(migratedLoginEmail
        ? { loginEmailUpdated: true as const, newLoginEmail: migratedLoginEmail }
        : {}),
    };
  }

  /**
   * One-time: when a referred member reaches FULL_MEMBER, set `referralJoinCreditedAt` so the referrer earns Pioneer Points.
   */
  private async maybeCreditReferralJoin(participantId: string): Promise<void> {
    const p = await this.prisma.participant.findUnique({
      where: { id: participantId },
      include: {
        pmesRecords: { orderBy: { timestamp: "desc" } },
        loiSubmission: true,
      },
    });
    if (!p?.referredByParticipantId || p.referralJoinCreditedAt) return;
    const passed = p.pmesRecords.some((r) => r.passed);
    const hasLoi = !!p.loiSubmission;
    const fees = !!p.initialFeesPaidAt;
    const board = !!p.boardApprovedAt;
    const profile = !!p.fullProfileCompletedAt;
    if (!passed || !hasLoi || !fees || !board || !profile) return;
    await this.prisma.participant.update({
      where: { id: participantId },
      data: { referralJoinCreditedAt: new Date() },
    });
  }

  private async referralRewardsForParticipant(participantId: string) {
    const monthStart = startOfCurrentUtcMonth();
    const [successfulJoinCount, invitesThisMonth] = await Promise.all([
      this.prisma.participant.count({
        where: { referredByParticipantId: participantId, referralJoinCreditedAt: { not: null } },
      }),
      this.prisma.participant.count({
        where: {
          referredByParticipantId: participantId,
          referralJoinCreditedAt: { gte: monthStart },
        },
      }),
    ]);
    return {
      successfulJoinCount,
      pioneerPoints: successfulJoinCount * REFERRAL_PIONEER_POINTS_PER_JOIN,
      invitesThisMonth,
    };
  }

  /**
   * Public (throttled): full name + TIN match a legacy-imported pioneer row that still needs the digital membership profile.
   * Returns `signInEmail` (synthesized or from import) for Firebase — roster sheets often had no member email column.
   */
  async checkPioneerEligibility(dto: PioneerEligibilityDto) {
    const rowLike: ImportLegacyPioneerRowDto = {
      firstName: dto.firstName,
      middleName: dto.middleName,
      lastName: dto.lastName,
    };
    const fullNameInput = composeLegacyFullName(rowLike);
    if (!fullNameInput || fullNameInput.length < 2) {
      throw new BadRequestException("firstName and lastName are required.");
    }
    const normalizedName = normalizeFullNameForMatch(fullNameInput);
    const tinDigits = normalizeTinDigits(dto.tinNo);
    if (!tinDigits.length) {
      throw new BadRequestException(
        "TIN is required after normalizing digits (use 000000000 if your roster row had no TIN).",
      );
    }

    const zeroTin = "000000000";
    const tinWhere: Prisma.ParticipantWhereInput =
      tinDigits === zeroTin
        ? {
            OR: [
              { tinNo: zeroTin },
              { tinNo: null },
              { memberIdNo: zeroTin },
              { memberIdNo: null },
            ],
          }
        : { OR: [{ tinNo: tinDigits }, { memberIdNo: tinDigits }] };

    const candidates = await this.prisma.participant.findMany({
      where: {
        legacyPioneerImport: true,
        fullProfileCompletedAt: null,
        ...tinWhere,
      },
      select: { email: true, fullName: true },
    });

    const matched = candidates.filter((c) => normalizeFullNameForMatch(c.fullName) === normalizedName);

    if (matched.length === 0) {
      return { eligible: false as const, reason: "not_found" as const };
    }
    if (matched.length > 1) {
      return { eligible: false as const, reason: "ambiguous" as const };
    }
    return { eligible: true as const, signInEmail: normalizeEmail(matched[0].email) };
  }

  /**
   * Core insert for one legacy pioneer row (same path as bulk import). Returns skip reason if not created.
   */
  private async tryCreateLegacyPioneerParticipant(
    row: ImportLegacyPioneerRowDto,
  ): Promise<{ ok: true; email: string } | { ok: false; email: string; reason: string }> {
    const fullName = composeLegacyFullName(row);
    if (!fullName || fullName.length < 2) {
      return { ok: false, email: row.email ?? "(no email)", reason: "fullName_or_name_parts_required" };
    }

    const genderRaw = resolveLegacyGender(row);
    const gender = (genderRaw && genderRaw.length > 0 ? genderRaw : "Unknown").slice(0, 80);

    const email = synthesizeLegacyImportEmail(row);
    const existing = await this.prisma.participant.findUnique({ where: { email } });
    if (existing) {
      return {
        ok: false,
        email,
        reason: existing.legacyPioneerImport ? "already_imported" : "email_already_registered",
      };
    }

    const dobRaw = row.dob?.trim();
    const dobPlaceholder = !dobRaw || dobRaw.length < 4;
    const dob = dobPlaceholder ? "1900-01-01" : dobRaw.slice(0, 64);

    const phone = row.phone?.trim() && row.phone.trim().length >= 5 ? row.phone.trim().slice(0, 80) : "+639000000000";

    const mailing = buildLegacyMailingAddress(row);
    const tinDigitsRaw = normalizeTinDigits(row.tinNo);
    /** Missing TIN on sheet: store nine zeroes so reclaim can match name + 000000000 (email may still be UUID if no TIN for synthesis). */
    const tinStored = (tinDigitsRaw.length > 0 ? tinDigitsRaw : "000000000").slice(0, 80);
    const civil = row.civilStatus?.trim().slice(0, 80) ?? null;

    const snapshot = buildRegistryImportSnapshot(row, { resolvedEmail: email, dobPlaceholder });

    const loiAddress =
      mailing?.trim() ||
      "(Imported — confirm or update in your membership form)";

    try {
      await this.prisma.participant.create({
        data: {
          email,
          fullName: fullName.slice(0, 500),
          phone,
          dob,
          gender,
          civilStatus: civil,
          tinNo: tinStored,
          memberIdNo: null,
          mailingAddress: mailing,
          legacyPioneerImport: true,
          registryImportSnapshot: snapshot,
          initialFeesPaidAt: new Date(),
          boardApprovedAt: new Date(),
          pmesRecords: {
            create: {
              score: 10,
              passed: true,
            },
          },
          loiSubmission: {
            create: {
              address: loiAddress.slice(0, 2000),
              occupation: "Legacy pioneer",
              employer: "—",
              initialCapital: 0,
            },
          },
        },
      });
      return { ok: true, email };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "create_failed";
      return { ok: false, email, reason: msg };
    }
  }

  /**
   * Superuser: add one legacy pioneer not included in the bulk roster (minimal row — same reclaim flow as bulk import).
   */
  async addLegacyPioneer(row: ImportLegacyPioneerRowDto) {
    const result = await this.tryCreateLegacyPioneerParticipant(row);
    if (!result.ok) {
      throw new BadRequestException(
        `Could not create legacy member (${result.email}): ${result.reason}.`,
      );
    }
    return {
      success: true as const,
      email: result.email,
      message:
        "Member can use Pioneer roster — link your account with the same full name + TIN stored here. Sign-in email is returned by eligibility check.",
    };
  }

  /**
   * Admin: bulk-create participants positioned at AWAITING_FULL_PROFILE (PMES passed, LOI/fees/board satisfied).
   * Accepts B2C registry columns: typically **`lastName` / `firstName` / `middleName`** (not a single `fullName`),
   * plus address, TIN, amounts, religion, `sheet` passthrough — optional email/phone/dob; missing email is
   * synthesized from TIN or a stable placeholder; missing dob uses a placeholder until staff updates for reclaim.
   */
  async importLegacyPioneers(rows: ImportLegacyPioneerRowDto[]) {
    const created: string[] = [];
    const skipped: { email: string; reason: string }[] = [];
    for (const row of rows) {
      const result = await this.tryCreateLegacyPioneerParticipant(row);
      if (result.ok) {
        created.push(result.email);
      } else {
        skipped.push({ email: result.email, reason: result.reason });
      }
    }
    return { created, skipped, totalInput: rows.length };
  }

  /**
   * Admin: searchable member registry (default: participants who completed the full membership form).
   * Denormalized columns are filled on submit; older rows fall back to parsing `fullProfileJson`.
   */
  async listMemberRegistry(params: { q?: string; page?: number; pageSize?: number; includeAll?: boolean }) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 50));
    const q = params.q?.trim();
    const includeAll = params.includeAll === true;

    const searchFilter: Prisma.ParticipantWhereInput | undefined = q
      ? {
          OR: [
            { fullName: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { phone: { contains: q, mode: "insensitive" } },
            { mailingAddress: { contains: q, mode: "insensitive" } },
            { memberIdNo: { contains: q, mode: "insensitive" } },
            { civilStatus: { contains: q, mode: "insensitive" } },
          ],
        }
      : undefined;

    const where: Prisma.ParticipantWhereInput = {
      ...(includeAll
        ? {}
        : {
            OR: [
              { fullProfileCompletedAt: { not: null } },
              { AND: [{ legacyPioneerImport: true }, { firebaseUid: null }] },
            ],
          }),
      ...(searchFilter ? searchFilter : {}),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.participant.count({ where }),
      this.prisma.participant.findMany({
        where,
        include: { loiSubmission: true },
        orderBy: [{ fullProfileCompletedAt: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const emails = [...new Set(rows.map((r) => normalizeEmail(r.email)))];
    const staffRows =
      emails.length > 0
        ? await this.prisma.staffUser.findMany({
            where: { email: { in: emails } },
            select: { email: true, role: true },
          })
        : [];
    const staffByEmail = new Map(staffRows.map((s) => [normalizeEmail(s.email), s.role]));

    return {
      rows: rows.map((p) => {
        const base = this.buildRegistryRow(p);
        const sr = staffByEmail.get(normalizeEmail(p.email)) ?? null;
        return {
          ...base,
          staffRole: sr,
          staffPosition: sr != null ? this.formatStaffPositionLabel(sr) : null,
        };
      }),
      total,
      page,
      pageSize,
    };
  }

  /** Admin: full participant detail for registry / audit (includes JSON profile snapshot). */
  async getParticipantAdminDetail(participantId: string) {
    const p = await this.prisma.participant.findUnique({
      where: { id: participantId },
      include: {
        loiSubmission: true,
        pmesRecords: { orderBy: { timestamp: "desc" }, take: 12 },
      },
    });
    if (!p) throw new NotFoundException("Participant not found");

    const envelope = parseFullProfileEnvelope(p.fullProfileJson);
    const snapshot = p.memberProfileSnapshot ?? envelope?.profile ?? null;

    const staffLogin = await this.prisma.staffUser.findUnique({
      where: { email: normalizeEmail(p.email) },
      select: { id: true, role: true },
    });
    const regBase = this.buildRegistryRow(p);
    const registry = {
      ...regBase,
      staffRole: staffLogin?.role ?? null,
      staffPosition: staffLogin ? this.formatStaffPositionLabel(staffLogin.role) : null,
    };

    return {
      registry,
      lifecycle: this.toLifecyclePayload(p),
      registryImportSnapshot: p.registryImportSnapshot ?? null,
      loiSubmission: p.loiSubmission,
      memberProfileSnapshot: snapshot,
      fullProfileMeta: envelope
        ? {
            formVersion: envelope.formVersion ?? null,
            sheetFileName: envelope.sheetFileName ?? null,
            notes: envelope.notes ?? null,
            submittedAt: envelope.submittedAt ?? null,
          }
        : null,
      pmesRecords: p.pmesRecords.map((r) => ({
        id: r.id,
        score: r.score,
        passed: r.passed,
        timestamp: r.timestamp.toISOString(),
      })),
    };
  }

  /** Admin or superuser: correct core participant fields (DB + Firebase email when linked). */
  async adminUpdateParticipant(participantId: string, dto: AdminUpdateParticipantDto) {
    const p = await this.prisma.participant.findUnique({
      where: { id: participantId },
      include: { loiSubmission: true },
    });
    if (!p) throw new NotFoundException("Participant not found");

    const data: Prisma.ParticipantUpdateInput = {};
    if (dto.fullName !== undefined) data.fullName = dto.fullName.trim();
    if (dto.phone !== undefined) data.phone = dto.phone.trim();
    if (dto.dob !== undefined) data.dob = dto.dob.trim();
    if (dto.gender !== undefined) data.gender = dto.gender.trim();
    if (dto.mailingAddress !== undefined) {
      data.mailingAddress = dto.mailingAddress.trim() ? dto.mailingAddress.trim() : null;
    }
    if (dto.civilStatus !== undefined) {
      data.civilStatus = dto.civilStatus.trim() ? dto.civilStatus.trim() : null;
    }
    if (dto.tinNo !== undefined) {
      const t = normalizeTinDigits(dto.tinNo);
      data.tinNo = t || null;
    }

    if (dto.email !== undefined) {
      const nextEmail = normalizeEmail(dto.email);
      if (nextEmail !== p.email) {
        const clash = await this.prisma.participant.findFirst({
          where: { email: nextEmail, id: { not: participantId } },
        });
        if (clash) {
          throw new ConflictException("That email is already used by another member record.");
        }
        if (p.firebaseUid) {
          await this.auth.updateFirebasePrimaryEmail(p.firebaseUid, nextEmail);
        }
        data.email = nextEmail;
      }
    }

    if (Object.keys(data).length > 0) {
      await this.prisma.participant.update({
        where: { id: participantId },
        data,
      });
    }

    return this.getParticipantAdminDetail(participantId);
  }

  /** Admin or superuser: set member Firebase password (member must have firebaseUid). */
  async adminResetMemberPassword(participantId: string, newPassword: string) {
    const p = await this.prisma.participant.findUnique({ where: { id: participantId } });
    if (!p) throw new NotFoundException("Participant not found");
    if (!p.firebaseUid?.trim()) {
      throw new BadRequestException(
        "This member has no Firebase account linked yet. They must sign in once (or sync) before a password can be set.",
      );
    }
    await this.auth.updateFirebaseUserPassword(p.firebaseUid, newPassword);
    return { success: true as const, message: "Password updated in Firebase Auth." };
  }

  private resolveProfileForDerivation(p: Participant): unknown {
    if (p.memberProfileSnapshot != null) return p.memberProfileSnapshot;
    const env = parseFullProfileEnvelope(p.fullProfileJson);
    return env?.profile ?? null;
  }

  private buildRegistryRow(p: Participant & { loiSubmission: LoiSubmission | null }): MemberRegistryRow {
    const profile = this.resolveProfileForDerivation(p);
    const derived = deriveFromMemberProfile(profile);
    const mailingFromCol = p.mailingAddress?.trim();
    const mailingFromProfile = derived.mailingAddress.trim();
    const mailingFromLoi = p.loiSubmission?.address?.trim();
    const mailingAddress =
      mailingFromCol || mailingFromProfile || mailingFromLoi
        ? mailingFromCol || mailingFromProfile || mailingFromLoi || null
        : null;
    const civilRaw = p.civilStatus?.trim() || derived.civilStatus.trim();
    const idRaw = p.memberIdNo?.trim() || derived.memberIdNo.trim();
    const civilStatus = civilRaw || null;
    const memberIdNo = idRaw || null;

    return {
      participantId: p.id,
      fullName: p.fullName,
      email: p.email,
      phone: p.phone,
      dob: p.dob,
      gender: p.gender,
      mailingAddress,
      civilStatus,
      memberIdNo,
      tinNo: p.tinNo?.trim() || null,
      firebaseUid: p.firebaseUid ?? null,
      loiAddress: p.loiSubmission?.address ?? null,
      fullProfileCompletedAt: p.fullProfileCompletedAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
      staffRole: null,
      staffPosition: null,
      legacyPioneerImport: Boolean(p.legacyPioneerImport),
    };
  }

  private formatStaffPositionLabel(role: StaffRole): string {
    switch (role) {
      case StaffRole.SUPERUSER:
        return "Superuser";
      case StaffRole.ADMIN:
        return "Admin";
      case StaffRole.TREASURER:
        return "Treasurer";
      case StaffRole.BOARD_DIRECTOR:
        return "Board director";
      case StaffRole.SECRETARY:
        return "Secretary";
      case StaffRole.CHAIRMAN:
        return "Chairperson";
      case StaffRole.VICE_CHAIRMAN:
        return "Vice Chairperson";
      case StaffRole.GENERAL_MANAGER:
        return "General manager";
      default:
        return String(role);
    }
  }

  /** Admin dashboard: applicants still completing membership (excludes finished full-member profiles). */
  async listMembershipPipeline() {
    const participants = await this.prisma.participant.findMany({
      /** In pipeline: normal applicants, plus legacy imports not yet claimed (no Firebase uid). */
      where: {
        fullProfileCompletedAt: null,
        OR: [
          { legacyPioneerImport: false },
          { AND: [{ legacyPioneerImport: true }, { firebaseUid: null }] },
        ],
      },
      include: {
        pmesRecords: { orderBy: { timestamp: "desc" }, take: 8 },
        loiSubmission: true,
      },
      orderBy: { createdAt: "desc" },
    });
    const ids = participants.map((p) => p.id);
    const voteGroups =
      ids.length > 0
        ? await this.prisma.boardApprovalVote.groupBy({
            by: ["participantId"],
            where: { participantId: { in: ids }, approve: true },
            _count: { _all: true },
          })
        : [];
    const voteMap = new Map(voteGroups.map((v) => [v.participantId, v._count._all]));
    return participants.map((p) => {
      const feeOk = Boolean(p.initialFeesPaidAt);
      const yesVotes = feeOk ? voteMap.get(p.id) ?? 0 : 0;
      const life = this.toLifecyclePayload(p, yesVotes);
      return {
        fullName: p.fullName,
        phone: p.phone,
        ...life,
      };
    });
  }

  private toLifecyclePayload(participant: ParticipantWithRelations, bodApproveVoteCount = 0) {
    const email = participant.email;
    const passed = participant.pmesRecords.some((r) => r.passed);
    const hasLoi = !!participant.loiSubmission;
    const fees = !!participant.initialFeesPaidAt;
    const board = !!participant.boardApprovedAt;
    const profile = !!participant.fullProfileCompletedAt;
    const bodMajority = !!participant.bodMajorityReachedAt;

    let stage: MembershipStage;
    if (!passed) stage = "PMES_NOT_PASSED";
    else if (!hasLoi) stage = "AWAITING_LOI";
    else if (!fees) stage = "AWAITING_PAYMENT";
    else if (board) {
      if (!profile) stage = "AWAITING_FULL_PROFILE";
      else stage = "FULL_MEMBER";
    } else if (bodMajority) stage = "AWAITING_SECRETARY_RESOLUTION";
    else stage = "AWAITING_BOD_VOTE";

    return {
      participantId: participant.id,
      email,
      stage,
      pmEsPassed: passed,
      loiSubmitted: hasLoi,
      initialFeesPaid: fees,
      boardApproved: board,
      fullProfileCompleted: profile,
      canAccessFullMemberPortal: stage === "FULL_MEMBER",
      bodApproveVoteCount: fees ? bodApproveVoteCount : 0,
      bodMajorityReached: fees && bodMajority,
      bodMajorityRequired: BOD_MAJORITY_APPROVALS,
      bodDirectorSeats: BOD_DIRECTOR_SEATS,
      boardResolutionNo: participant.boardResolutionNo ?? null,
      needsTin: !String(participant.tinNo ?? "").trim(),
      tinMissingFlaggedAt: participant.tinMissingFlaggedAt ?? null,
      /** Matches `Participant.memberProfileConcurrencyStamp` for optimistic locking on full-profile submit. */
      profileRecordVersion: participant.memberProfileConcurrencyStamp,
      /** Pre-roster import: member already pledged elsewhere; digital PMES not required on this app. */
      isLegacyFounderImport: participant.legacyPioneerImport,
      /** Assigned once by the server; format B2C-{initials}-{YY}-{suffix} (memorable + unguessable tail). */
      memberIdNo: participant.memberIdNo,
      /** Optional member-chosen handle (unique). */
      callsign: participant.callsign,
      /** Callsign if set, else `lastNameKey-lastNameSeq` when assigned (e.g. cruz-2). */
      alternatePublicHandle: computeAlternatePublicHandle({
        callsign: participant.callsign,
        lastNameKey: participant.lastNameKey,
        lastNameSeq: participant.lastNameSeq,
      }),
      /**
       * True until the first successful full-profile submit. Provisional IDs use the registration-year cohort when the
       * account had no reliable DOB; submit replaces with a permanent ID from the form date of birth.
       */
      memberIdIsProvisional: !profile,
      /** From Participant row (PMES registration / sync); client may prefill the membership sheet. */
      registrationFullName: participant.fullName,
      registrationDob: participant.dob,
      registrationGender: participant.gender,
      registrationPhone: participant.phone,
    };
  }

  /**
   * Map email, callsign, default alternate (`lastname-seq`), or member ID → account email for Firebase sign-in.
   * Returns null if nothing matches.
   */
  async resolveLoginEmailForFirebase(raw: string): Promise<{ email: string } | null> {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) return null;

    if (trimmed.includes("@")) {
      const email = normalizeEmail(trimmed);
      const byEmail = await this.prisma.participant.findUnique({
        where: { email },
        select: { email: true },
      });
      return byEmail ? { email: byEmail.email } : null;
    }

    const byMemberId = await this.prisma.participant.findFirst({
      where: { memberIdNo: { equals: trimmed, mode: "insensitive" } },
      select: { email: true },
    });
    if (byMemberId) return { email: byMemberId.email };

    const tinDigits = digitsOnly(trimmed);
    if (tinDigits.length === 9) {
      const byTin = await this.prisma.participant.findFirst({
        where: { tinNo: { equals: tinDigits, mode: "insensitive" } },
        select: { email: true },
      });
      if (byTin) return { email: byTin.email };
    }

    const lower = trimmed.toLowerCase();
    const byCallsign = await this.prisma.participant.findUnique({
      where: { callsign: lower },
      select: { email: true },
    });
    if (byCallsign) return { email: byCallsign.email };

    const m = lower.match(/^([a-z0-9]{2,})-(\d{1,5})$/);
    if (m) {
      const slug = m[1]!;
      const seq = parseInt(m[2]!, 10);
      if (!Number.isFinite(seq) || seq < 1) return null;
      const bySlug = await this.prisma.participant.findFirst({
        where: { lastNameKey: slug, lastNameSeq: seq },
        select: { email: true },
      });
      if (bySlug) return { email: bySlug.email };
    }

    return null;
  }

  /**
   * Optional callsign or clear it (Firebase-authenticated via controller).
   * Does not change last-name sequence; clearing falls back to default alternate.
   */
  async setMemberCallsign(dto: { email: string; callsign?: string }) {
    const email = normalizeEmail(dto.email);
    const participant = await this.prisma.participant.findUnique({ where: { email } });
    if (!participant) throw new NotFoundException("Participant not found");

    const raw =
      dto.callsign === undefined || dto.callsign === null ? "" : String(dto.callsign).trim();

    if (!raw) {
      const updated = await this.prisma.participant.update({
        where: { id: participant.id },
        data: { callsign: null, memberProfileConcurrencyStamp: { increment: 1 } },
      });
      return {
        success: true as const,
        callsign: null as string | null,
        alternatePublicHandle: computeAlternatePublicHandle({
          callsign: null,
          lastNameKey: updated.lastNameKey,
          lastNameSeq: updated.lastNameSeq,
        }),
      };
    }

    const normalized = validateAndNormalizeCallsignInput(raw);
    await this.assertCallsignAvailable(normalized, participant.id);
    const updated = await this.prisma.participant.update({
      where: { id: participant.id },
      data: { callsign: normalized, memberProfileConcurrencyStamp: { increment: 1 } },
    });
    return {
      success: true as const,
      callsign: normalized,
      alternatePublicHandle: computeAlternatePublicHandle({
        callsign: updated.callsign,
        lastNameKey: updated.lastNameKey,
        lastNameSeq: updated.lastNameSeq,
      }),
    };
  }

  /**
   * Member: update core participant fields from the portal “Member profile” screen (Firebase Bearer required in controller).
   */
  async updateMemberBasicProfile(dto: UpdateMemberBasicProfileDto) {
    const email = normalizeEmail(dto.email);
    const participant = await this.prisma.participant.findUnique({ where: { email } });
    if (!participant) throw new NotFoundException("Participant not found");

    const data: Prisma.ParticipantUpdateInput = {};

    if (dto.fullName !== undefined) {
      const t = dto.fullName.trim();
      if (!t) throw new BadRequestException("fullName cannot be empty");
      data.fullName = t.slice(0, 500);
    }
    if (dto.phone !== undefined) {
      const t = dto.phone.trim();
      if (!t) throw new BadRequestException("phone cannot be empty");
      data.phone = t.slice(0, 64);
    }
    if (dto.dob !== undefined) {
      const t = dto.dob.trim();
      if (!t) throw new BadRequestException("dob cannot be empty");
      data.dob = t.slice(0, 32);
    }
    if (dto.gender !== undefined) {
      const t = dto.gender.trim();
      if (!t) throw new BadRequestException("gender cannot be empty");
      data.gender = t.slice(0, 32);
    }
    if (dto.mailingAddress !== undefined) {
      const t = dto.mailingAddress.trim();
      data.mailingAddress = t ? t.slice(0, 4000) : null;
    }
    if (dto.tinNo !== undefined) {
      const digits = normalizeTinDigitsMembership(dto.tinNo);
      if (digits && !isValidTin(digits)) {
        throw new BadRequestException("TIN must be 9–12 digits.");
      }
      if (digits) {
        const clash = await this.prisma.participant.findFirst({
          where: { tinNo: digits, NOT: { id: participant.id } },
          select: { id: true },
        });
        if (clash) throw new ConflictException("This TIN is already on file. Contact the Secretary.");
      }
      data.tinNo = digits || null;
      data.tinMissingFlaggedAt = digits ? null : new Date();
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException("Provide at least one field to update.");
    }

    await this.prisma.participant.update({
      where: { id: participant.id },
      data: { ...data, memberProfileConcurrencyStamp: { increment: 1 } },
    });

    return { success: true as const };
  }

  /**
   * Member: align Firebase Auth + Postgres login email; patch `contact.emailAddress` in stored profile JSON when present.
   * @param firebaseUidFromToken UID from verified ID token (same email). Used to set `Participant.firebaseUid` when missing.
   */
  async updateMemberLoginEmail(dto: { email: string; newEmail: string }, firebaseUidFromToken: string | null) {
    const current = normalizeEmail(dto.email);
    let participant = await this.prisma.participant.findUnique({
      where: { email: current },
      include: {
        pmesRecords: { orderBy: { timestamp: "desc" } },
        loiSubmission: true,
      },
    });
    if (!participant) {
      throw new NotFoundException("Participant not found");
    }

    let uid: string;
    if (participant.firebaseUid) {
      if (firebaseUidFromToken && participant.firebaseUid !== firebaseUidFromToken) {
        throw new ForbiddenException("Your session does not match this member record.");
      }
      uid = participant.firebaseUid;
    } else if (firebaseUidFromToken) {
      const existingUid = await this.prisma.participant.findUnique({
        where: { firebaseUid: firebaseUidFromToken },
        select: { id: true },
      });
      if (existingUid && existingUid.id !== participant.id) {
        throw new ConflictException("This Firebase login is already linked to another member record.");
      }
      participant = await this.prisma.participant.update({
        where: { id: participant.id },
        data: { firebaseUid: firebaseUidFromToken },
        include: {
          pmesRecords: { orderBy: { timestamp: "desc" } },
          loiSubmission: true,
        },
      });
      uid = firebaseUidFromToken;
    } else {
      throw new BadRequestException(
        "Your member record has no Firebase user id. Reload the app so POST /auth/sync-member can run, " +
          "or set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY on the API so the server can verify your session.",
      );
    }

    const next = normalizeEmail(dto.newEmail);
    if (next === current) {
      return { success: true as const, changed: false as const, newLoginEmail: current };
    }

    const previousLoginEmail = current;
    const migratedLoginEmail = await this.auth.updateFirebasePrimaryEmail(uid, dto.newEmail);

    let nextSnapshot: Prisma.InputJsonValue | undefined;
    if (participant.memberProfileSnapshot != null) {
      const merged = this.mergeContactEmailIntoProfileJson(
        participant.memberProfileSnapshot as unknown,
        migratedLoginEmail,
      );
      if (asObject(merged)) {
        nextSnapshot = merged as Prisma.InputJsonValue;
      }
    }

    let nextFullProfileJson: string | undefined;
    const env = parseFullProfileEnvelope(participant.fullProfileJson);
    if (env && env.profile !== undefined) {
      const mergedProfile = this.mergeContactEmailIntoProfileJson(env.profile, migratedLoginEmail);
      nextFullProfileJson = JSON.stringify({ ...env, profile: mergedProfile });
    }

    try {
      const updated = await this.prisma.participant.update({
        where: { id: participant.id },
        data: {
          email: migratedLoginEmail,
          memberProfileConcurrencyStamp: { increment: 1 },
          ...(nextSnapshot !== undefined ? { memberProfileSnapshot: nextSnapshot } : {}),
          ...(nextFullProfileJson !== undefined ? { fullProfileJson: nextFullProfileJson } : {}),
        },
        include: {
          pmesRecords: { orderBy: { timestamp: "desc" } },
          loiSubmission: true,
        },
      });
      return {
        success: true as const,
        changed: true as const,
        newLoginEmail: migratedLoginEmail,
        loginEmailUpdated: true as const,
        lifecycle: this.toLifecyclePayload(updated),
      };
    } catch (err) {
      try {
        await this.auth.updateFirebasePrimaryEmail(uid, previousLoginEmail);
      } catch (rollbackErr) {
        this.logger.error(
          "Failed to revert Firebase primary email after login-email DB failure; manual fix may be needed.",
          rollbackErr instanceof Error ? rollbackErr.stack : String(rollbackErr),
        );
      }
      throw err;
    }
  }

  private async assertCallsignAvailable(normalized: string, excludeParticipantId: string): Promise<void> {
    const other = await this.prisma.participant.findFirst({
      where: {
        id: { not: excludeParticipantId },
        OR: [
          { callsign: normalized },
          { memberIdNo: { equals: normalized, mode: "insensitive" } },
        ],
      },
      select: { id: true },
    });
    if (other) {
      throw new ConflictException("That handle is already in use. Choose a different one.");
    }
  }

  /**
   * Assigns a **provisional** public member ID when missing: `B2C-{initials}-{cohortYY}-{rand4}`.
   * Cohort uses account `dob` when year is 1920–2100; otherwise **registration year** (e.g. 26 for 2026). First full-profile
   * submit replaces this with a **permanent** ID from the form date of birth (`assignPermanentMemberIdForFullProfileSubmit`).
   * Preserves any non-empty ID. Older pioneer imports put **TIN** in `memberIdNo` — moved to `tinNo` first.
   */
  private async ensureMemberPublicId(
    participant: ParticipantWithRelations,
    profile?: unknown,
  ): Promise<ParticipantWithRelations> {
    if (isNineDigitTinPlaceholderInMemberIdSlot(participant.legacyPioneerImport, participant.memberIdNo)) {
      const tin = digitsOnly(participant.memberIdNo);
      participant = await this.prisma.participant.update({
        where: { id: participant.id },
        data: {
          tinNo: participant.tinNo?.trim() || tin,
          memberIdNo: null,
        },
        include: {
          pmesRecords: { orderBy: { timestamp: "desc" } },
          loiSubmission: true,
        },
      });
    }

    if (String(participant.memberIdNo ?? "").trim()) {
      return participant;
    }

    let initials = initialsFromFullName(participant.fullName);
    let yy = cohortYYFromDob(participant.dob, participant.createdAt);

    const root = profile ? asObject(profile) : null;
    const personal = root ? asObject(root.personal) : null;
    if (personal) {
      const fn = typeof personal.firstName === "string" ? personal.firstName : "";
      const ln = typeof personal.lastName === "string" ? personal.lastName : "";
      if (fn.trim() && ln.trim()) {
        initials = initialsFromFirstLast(fn, ln, participant.fullName);
      }
      const bd = typeof personal.birthDate === "string" ? personal.birthDate : "";
      if (bd.trim()) {
        yy = cohortYYFromDob(bd, participant.createdAt);
      }
    }

    for (let attempt = 0; attempt < 16; attempt++) {
      const id = buildMemberPublicId(initials, yy);
      const clash = await this.prisma.participant.findFirst({
        where: { memberIdNo: id, id: { not: participant.id } },
        select: { id: true },
      });
      if (clash) continue;

      return await this.prisma.participant.update({
        where: { id: participant.id },
        data: { memberIdNo: id },
        include: {
          pmesRecords: { orderBy: { timestamp: "desc" } },
          loiSubmission: true,
        },
      });
    }

    throw new InternalServerErrorException("Could not allocate a unique member ID after retries.");
  }

  /**
   * First full-profile submission: assign permanent `B2C-…` from legal name + **form** date of birth cohort.
   * Replaces any provisional ID (registration-year middle segment from account creation).
   */
  private async assignPermanentMemberIdForFullProfileSubmit(
    participant: ParticipantWithRelations,
    profile: unknown,
  ): Promise<ParticipantWithRelations> {
    const root = asObject(profile);
    const personal = root ? asObject(root.personal) : null;
    const birthDateRaw = personal && typeof personal.birthDate === "string" ? personal.birthDate.trim() : "";
    if (!birthDateRaw) {
      throw new BadRequestException(
        "Enter your date of birth on the membership form to finalize your permanent member ID (middle segment = your birth year).",
      );
    }
    const y = parseYearFromDob(birthDateRaw);
    if (y === null || y < 1920 || y > 2100) {
      throw new BadRequestException(
        "Enter a valid date of birth (year 1920–2100) so your member ID can use the correct birth-year cohort.",
      );
    }

    const fn = personal && typeof personal.firstName === "string" ? personal.firstName : "";
    const ln = personal && typeof personal.lastName === "string" ? personal.lastName : "";
    let initials = initialsFromFullName(participant.fullName);
    if (fn.trim() && ln.trim()) {
      initials = initialsFromFirstLast(fn, ln, participant.fullName);
    }

    const yy = cohortYYFromDob(birthDateRaw, participant.createdAt);
    const oldId = String(participant.memberIdNo ?? "").trim();

    for (let attempt = 0; attempt < 24; attempt++) {
      const id = buildMemberPublicId(initials, yy);
      const clash = await this.prisma.participant.findFirst({
        where: {
          memberIdNo: { equals: id, mode: "insensitive" },
          id: { not: participant.id },
        },
        select: { id: true },
      });
      if (clash) continue;

      if (id === oldId) {
        return participant;
      }

      return await this.prisma.participant.update({
        where: { id: participant.id },
        data: { memberIdNo: id },
        include: {
          pmesRecords: { orderBy: { timestamp: "desc" } },
          loiSubmission: true,
        },
      });
    }

    throw new InternalServerErrorException("Could not allocate a unique permanent member ID after retries.");
  }

  private flattenRecord(
    participant: {
      fullName: string;
      email: string;
      phone: string;
      dob: string;
      gender: string;
      legacyPioneerImport?: boolean;
    },
    record: { id: string; score: number; passed: boolean; timestamp: Date },
  ) {
    return {
      id: record.id,
      fullName: participant.fullName,
      email: participant.email,
      phone: participant.phone,
      dob: participant.dob,
      gender: participant.gender,
      score: record.score,
      passed: record.passed,
      timestamp: record.timestamp.toISOString(),
      legacyPioneerImport: Boolean(participant.legacyPioneerImport),
    };
  }
}
