import { getSql } from "@/lib/db";
import { postInitialFeesPaidAwait } from "@/lib/accounting-integration";
import {
  buildMemberPublicId,
  cohortYYFromDob,
  initialsFromFirstLast,
  initialsFromFullName,
} from "@/lib/pmes-edge/member-public-id";
import { blockingFinding, evaluateDuplicates, firstFlaggedParticipantId, type DuplicateLookup } from "@/lib/membership/duplicate-engine";
import { approvedEmail, rejectedEmail, resumeEmail, setPasswordEmail, treasurerPromptEmail } from "@/lib/membership/email-templates";
import { createFirebaseMemberAccount } from "@/lib/membership/firebase-signup";
import { sendMembershipEmail } from "@/lib/membership/mailer";
import { draftIpWindow, isRateLimited, lookupIpWindow, submitEmailWindow } from "@/lib/membership/rate-limit";
import { derivedApplicationStatus, nextStatusAfterLifecycle } from "@/lib/membership/status-sync";
import { generateResumeToken, hashResumeToken } from "@/lib/membership/tokens";
import { verifyTurnstile } from "@/lib/membership/turnstile";
import {
  composeFullName,
  DPA_CONSENT_VERSION_DEFAULT,
  DRAFT_TTL_DAYS,
  formatDobIso,
  formatMailingAddress,
  MEMBER_ID_COLLISION_RETRIES,
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
} from "@/lib/membership/validators";

type Sql = ReturnType<typeof getSql>;

export type ApplicationRow = {
  id: string;
  status: string;
  resumeTokenHash: string;
  participantId: string | null;
  fullName: string | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  dob: string | Date | null;
  gender: string | null;
  email: string;
  mobile: string | null;
  tinNo: string | null;
  residentialAddress: unknown;
  referredByParticipantId: string | null;
  shareCapitalAmount: string | number;
  shareCapitalPaid: boolean;
  membershipFeeAmount: string | number;
  membershipFeePaid: boolean;
  paymentMode: string | null;
  gcashRefNo: string | null;
  gcashScreenshotKey: string | null;
  paymentDeclaredAt: string | Date | null;
  possibleDuplicateOfId: string | null;
  submittedAt: string | Date | null;
  dpaConsentAt: string | Date | null;
  createdAt: string | Date;
};

function jsonError(message: string, status: number, extra?: Record<string, unknown>) {
  return { ok: false as const, status, body: { message, statusCode: status, ...extra } };
}

function publicAppUrl() {
  return String(process.env.PUBLIC_APP_URL ?? "https://b2ccoop.com").replace(/\/$/, "");
}

function maskName(fullName: string): string {
  const parts = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Member";
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]!.slice(0, 1).toUpperCase()}.` : parts[0]!;
}

export function toPublicApplication(row: ApplicationRow) {
  const dob = row.dob ? formatDobIso(parseIsoDateOnly(row.dob) ?? new Date(row.dob)) : null;
  return {
    id: row.id,
    status: row.status,
    fullName: row.fullName,
    firstName: row.firstName,
    middleName: row.middleName,
    lastName: row.lastName,
    dob,
    gender: row.gender,
    email: row.email,
    mobile: row.mobile,
    tinNo: row.tinNo,
    residentialAddress: row.residentialAddress,
    referredByParticipantId: row.referredByParticipantId,
    shareCapitalAmount: Number(row.shareCapitalAmount),
    shareCapitalPaid: Boolean(row.shareCapitalPaid),
    membershipFeeAmount: Number(row.membershipFeeAmount),
    membershipFeePaid: Boolean(row.membershipFeePaid),
    paymentMode: row.paymentMode,
    gcashRefNo: row.gcashRefNo,
    hasGcashScreenshot: Boolean(row.gcashScreenshotKey),
    possibleDuplicateOfId: row.possibleDuplicateOfId,
    submittedAt: row.submittedAt,
    participantId: row.participantId,
    dpaConsentAt: row.dpaConsentAt,
  };
}

async function consumeRate(sql: Sql, window: { bucketKey: string; windowStart: Date; limit: number }) {
  const rows = await sql`
    INSERT INTO "MembershipRateLimit" ("id", "bucketKey", "windowStart", "count")
    VALUES (${crypto.randomUUID()}, ${window.bucketKey}, ${window.windowStart}, 1)
    ON CONFLICT ("bucketKey", "windowStart")
    DO UPDATE SET "count" = "MembershipRateLimit"."count" + 1
    RETURNING "count"
  `;
  const count = Number((rows as { count: number }[])[0]?.count ?? 1);
  if (isRateLimited(count - 1, window.limit)) {
    return jsonError("Too many requests. Please try again later.", 429);
  }
  return null;
}

async function requireCaptcha(token: string | undefined, ip: string) {
  const v = await verifyTurnstile(token, ip);
  if (!v.ok) return jsonError(v.message ?? "Captcha verification failed.", 400);
  return null;
}

async function loadByToken(sql: Sql, id: string, token: string) {
  const rows = await sql`SELECT * FROM "MembershipApplication" WHERE id = ${id} LIMIT 1`;
  const row = (rows as ApplicationRow[])[0];
  if (!row) return { error: jsonError("Application not found", 404) };
  if ((await hashResumeToken(token)) !== row.resumeTokenHash) {
    return { error: jsonError("Resume token is invalid.", 401) };
  }
  return { row };
}

function liteFrom(p: {
  id: string;
  email: string;
  phone: string | null;
  tinNo: string | null;
  fullName: string;
  dob: string | Date | null;
  boardApprovedAt: string | Date | null;
  legacyPioneerImport: boolean;
} | null) {
  return p;
}

function duplicateLookup(sql: Sql): DuplicateLookup {
  return {
    findParticipantByEmail: async (email) => {
      const rows = await sql`
        SELECT id, email, phone, "tinNo", "fullName", dob, "boardApprovedAt", "legacyPioneerImport"
        FROM "Participant" WHERE email = ${email} LIMIT 1
      `;
      return liteFrom((rows as never[])[0] ?? null);
    },
    findParticipantByMobile: async (mobile) => {
      const rows = await sql`
        SELECT id, email, phone, "tinNo", "fullName", dob, "boardApprovedAt", "legacyPioneerImport"
        FROM "Participant" WHERE phone = ${mobile} LIMIT 1
      `;
      return liteFrom((rows as never[])[0] ?? null);
    },
    findParticipantByTin: async (tin) => {
      const rows = await sql`
        SELECT id, email, phone, "tinNo", "fullName", dob, "boardApprovedAt", "legacyPioneerImport"
        FROM "Participant" WHERE "tinNo" = ${tin} LIMIT 1
      `;
      return liteFrom((rows as never[])[0] ?? null);
    },
    findParticipantByNameDob: async (fullName, dobIso) => {
      const rows = await sql`
        SELECT id, email, phone, "tinNo", "fullName", dob, "boardApprovedAt", "legacyPioneerImport"
        FROM "Participant" WHERE dob = ${dobIso} LIMIT 20
      `;
      const hit = (rows as Array<{ fullName: string }>).find(
        (r) => r.fullName.trim().replace(/\s+/g, " ").toLowerCase() === fullName,
      );
      return liteFrom((hit as never) ?? null);
    },
    findOpenApplicationByEmail: async (email) => {
      const rows = await sql`
        SELECT id, email, status FROM "MembershipApplication"
        WHERE email = ${email} AND status IN ('DRAFT', 'SUBMITTED')
        LIMIT 1
      `;
      return (rows as { id: string; email: string; status: string }[])[0] ?? null;
    },
  };
}

export async function resolveApprovedReferrer(sql: Sql, raw: string): Promise<string | null> {
  const q = String(raw ?? "").trim();
  if (!q) return null;
  const pioneer = q.match(/^PIONEER-([a-fA-F0-9]{8})$/i);
  if (pioneer?.[1]) {
    const suffix = pioneer[1].toUpperCase();
    const rows = await sql`
      SELECT id, "boardApprovedAt" FROM "Participant"
      WHERE "firebaseUid" IS NOT NULL
        AND UPPER(RIGHT(REPLACE("firebaseUid", '-', ''), 8)) = ${suffix}
      LIMIT 2
    `;
    const list = rows as { id: string; boardApprovedAt: string | Date | null }[];
    if (list.length === 1 && list[0]!.boardApprovedAt) return list[0]!.id;
    return null;
  }
  const rows = await sql`
    SELECT id FROM "Participant"
    WHERE "boardApprovedAt" IS NOT NULL
      AND (id = ${q} OR "memberIdNo" = ${q} OR callsign = ${q.toLowerCase()})
    LIMIT 1
  `;
  return (rows as { id: string }[])[0]?.id ?? null;
}

async function allocateMemberId(sql: Sql, fullName: string, firstName: string | null, lastName: string | null, dobIso: string) {
  const initials = firstName && lastName ? initialsFromFirstLast(firstName, lastName, fullName) : initialsFromFullName(fullName);
  const yy = cohortYYFromDob(dobIso, new Date());
  for (let i = 0; i < MEMBER_ID_COLLISION_RETRIES; i++) {
    const id = buildMemberPublicId(initials, yy);
    const clash = await sql`SELECT id FROM "Participant" WHERE "memberIdNo" = ${id} LIMIT 1`;
    if ((clash as { id: string }[]).length === 0) return id;
  }
  throw new Error(`Could not allocate a unique member ID after ${MEMBER_ID_COLLISION_RETRIES} retries.`);
}

async function notifyTreasurers(sql: Sql, row: ApplicationRow, memberIdNo?: string | null) {
  const staff = await sql`
    SELECT email FROM "StaffUser" WHERE role IN ('TREASURER', 'SUPERUSER')
  `;
  let targets = staff as { email: string }[];
  if (!targets.length) {
    targets = (await sql`SELECT email FROM "StaffUser" WHERE role = 'ADMIN'`) as { email: string }[];
  }
  for (const t of targets) {
    await sendMembershipEmail(
      treasurerPromptEmail({
        to: t.email,
        applicantName: row.fullName || row.email,
        applicantEmail: row.email,
        memberIdNo,
        declaredPaid: Boolean(row.shareCapitalPaid || row.membershipFeePaid),
        paymentMode: row.paymentMode,
        gcashRefNo: row.gcashRefNo,
      }),
    ).catch(() => undefined);
  }
  await sql`UPDATE "MembershipApplication" SET "treasurerNotifiedAt" = NOW(), "updatedAt" = NOW() WHERE id = ${row.id}`;
}

export async function createDraft(input: {
  email: string;
  mobile?: string;
  dpaConsent: boolean;
  captchaToken?: string;
  referralCode?: string;
  ip: string;
  userAgent?: string;
}) {
  const sql = getSql();
  const captcha = await requireCaptcha(input.captchaToken, input.ip);
  if (captcha) return captcha;
  const limited = await consumeRate(sql, draftIpWindow(input.ip));
  if (limited) return limited;
  if (!input.dpaConsent) return jsonError("Data Privacy Act consent is required.", 400);
  const email = normalizeEmail(input.email);
  const mobile = input.mobile ? normalizePhMobile(input.mobile) : null;
  const existing = await sql`
    SELECT * FROM "MembershipApplication"
    WHERE email = ${email} AND status IN ('DRAFT', 'SUBMITTED')
    LIMIT 1
  `;
  const open = (existing as ApplicationRow[])[0];
  const token = await generateResumeToken();
  const hash = await hashResumeToken(token);
  if (open) {
    await sql`UPDATE "MembershipApplication" SET "resumeTokenHash" = ${hash}, "updatedAt" = NOW() WHERE id = ${open.id}`;
    await sendMembershipEmail(resumeEmail({ to: email, continueUrl: `${publicAppUrl()}/register/continue?t=${encodeURIComponent(token)}` })).catch(() => undefined);
    return { ok: true as const, status: 200, body: { ...toPublicApplication(open), resumeToken: token, resumed: true } };
  }
  const referrer = input.referralCode ? await resolveApprovedReferrer(sql, input.referralCode) : null;
  const id = crypto.randomUUID();
  const created = await sql`
    INSERT INTO "MembershipApplication" (
      id, status, "resumeTokenHash", email, mobile, "dpaConsentAt", "dpaConsentVersion",
      "consentIp", "userAgent", "referredByParticipantId", "shareCapitalAmount", "membershipFeeAmount",
      "createdAt", "updatedAt"
    ) VALUES (
      ${id}, 'DRAFT', ${hash}, ${email}, ${mobile}, NOW(), ${process.env.DPA_CONSENT_VERSION?.trim() || DPA_CONSENT_VERSION_DEFAULT},
      ${input.ip.slice(0, 64)}, ${(input.userAgent ?? "").slice(0, 500)}, ${referrer},
      ${MIN_SHARE_CAPITAL}, ${MEMBERSHIP_FEE_DEFAULT}, NOW(), NOW()
    )
    RETURNING *
  `;
  const row = (created as ApplicationRow[])[0]!;
  await sendMembershipEmail(resumeEmail({ to: email, continueUrl: `${publicAppUrl()}/register/continue?t=${encodeURIComponent(token)}` })).catch(() => undefined);
  return { ok: true as const, status: 201, body: { ...toPublicApplication(row), resumeToken: token, resumed: false } };
}

export async function getDraft(id: string, token: string) {
  const loaded = await loadByToken(getSql(), id, token);
  if (loaded.error) return loaded.error;
  return { ok: true as const, status: 200, body: toPublicApplication(loaded.row) };
}

export async function patchDraft(id: string, token: string, fields: Record<string, unknown>) {
  const sql = getSql();
  const loaded = await loadByToken(sql, id, token);
  if (loaded.error) return loaded.error;
  const row = loaded.row;
  if (row.status !== "DRAFT" && row.status !== "SUBMITTED") {
    return jsonError("This application can no longer be edited.", 400);
  }
  const warnings: { field: string; message: string }[] = [];
  let fullName = row.fullName;
  let firstName = row.firstName;
  let middleName = row.middleName;
  let lastName = row.lastName;
  let dob = row.dob;
  let gender = row.gender;
  let mobile = row.mobile;
  let tinNo = row.tinNo;
  let address = row.residentialAddress;
  let referredBy = row.referredByParticipantId;
  let share = Number(row.shareCapitalAmount);
  let sharePaid = row.shareCapitalPaid;
  let feePaid = row.membershipFeePaid;
  let mode = row.paymentMode;
  let gcash = row.gcashRefNo;

  if (fields.fullName !== undefined) fullName = String(fields.fullName ?? "").trim() || null;
  if (fields.firstName !== undefined) firstName = String(fields.firstName ?? "").trim() || null;
  if (fields.middleName !== undefined) middleName = String(fields.middleName ?? "").trim() || null;
  if (fields.lastName !== undefined) lastName = String(fields.lastName ?? "").trim() || null;
  if (fields.gender !== undefined) gender = String(fields.gender ?? "").trim() || null;
  if (fields.dob !== undefined) dob = parseIsoDateOnly(fields.dob as string);
  if (fields.mobile !== undefined) mobile = fields.mobile ? normalizePhMobile(String(fields.mobile)) : null;
  if (fields.tinNo !== undefined) tinNo = fields.tinNo ? normalizeTinDigits(String(fields.tinNo)) || null : null;
  if (fields.residentialAddress !== undefined) address = fields.residentialAddress;
  if (fields.referredByParticipantId !== undefined) {
    referredBy = fields.referredByParticipantId ? await resolveApprovedReferrer(sql, String(fields.referredByParticipantId)) : null;
    if (fields.referredByParticipantId && !referredBy) return jsonError("Referred by must be an approved member.", 400);
  }
  if (fields.referralQuery) {
    const resolved = await resolveApprovedReferrer(sql, String(fields.referralQuery));
    if (resolved) referredBy = resolved;
  }
  if (fields.shareCapitalAmount !== undefined) {
    const n = validateShareCapital(fields.shareCapitalAmount);
    if (n != null) share = n;
  }
  if (fields.shareCapitalPaid !== undefined) sharePaid = fields.shareCapitalPaid === true;
  if (fields.membershipFeePaid !== undefined) feePaid = fields.membershipFeePaid === true;
  if (fields.paymentMode !== undefined) mode = parsePaymentMode(fields.paymentMode);
  if (fields.gcashRefNo !== undefined) gcash = fields.gcashRefNo ? validateGcashRef(String(fields.gcashRefNo)) : null;

  for (const key of Object.keys(fields)) {
    const issue = validateDraftField(key, fields[key]);
    if (issue && fields[key] != null && String(fields[key]).trim() !== "") warnings.push(issue);
  }
  if (!fullName) fullName = composeFullName(firstName, middleName, lastName, row.fullName);

  const dups = await evaluateDuplicates(
    { email: row.email, mobile, tinNo, fullName, dob, excludeApplicationId: row.id },
    duplicateLookup(sql),
  );
  const flagId = firstFlaggedParticipantId(dups);
  const paidChanged = sharePaid || feePaid;
  const updated = await sql`
    UPDATE "MembershipApplication" SET
      "fullName" = ${fullName},
      "firstName" = ${firstName},
      "middleName" = ${middleName},
      "lastName" = ${lastName},
      dob = ${dob instanceof Date ? formatDobIso(dob) : dob},
      gender = ${gender},
      mobile = ${mobile},
      "tinNo" = ${tinNo},
      "residentialAddress" = ${JSON.stringify(address ?? null)}::jsonb,
      "referredByParticipantId" = ${referredBy},
      "shareCapitalAmount" = ${share},
      "shareCapitalPaid" = ${sharePaid},
      "membershipFeePaid" = ${feePaid},
      "paymentMode" = ${mode},
      "gcashRefNo" = ${gcash},
      "possibleDuplicateOfId" = ${flagId},
      "paymentDeclaredAt" = CASE WHEN ${paidChanged} THEN COALESCE("paymentDeclaredAt", NOW()) ELSE "paymentDeclaredAt" END,
      "updatedAt" = NOW()
    WHERE id = ${row.id}
    RETURNING *
  `;
  const next = (updated as ApplicationRow[])[0]!;
  if (paidChanged && next.status !== "DRAFT") await notifyTreasurers(sql, next);
  return {
    ok: true as const,
    status: 200,
    body: { application: toPublicApplication(next), warnings, duplicateFlags: dups.filter((f) => f.action === "flag") },
  };
}

export async function submitDraft(id: string, token: string, input: { captchaToken?: string; ip: string }) {
  const sql = getSql();
  const captcha = await requireCaptcha(input.captchaToken, input.ip);
  if (captcha) return captcha;
  const loaded = await loadByToken(sql, id, token);
  if (loaded.error) return loaded.error;
  const row = loaded.row;
  if (row.status !== "DRAFT" && row.status !== "SUBMITTED") {
    return jsonError("This application was already processed.", 400);
  }
  const limited = await consumeRate(sql, submitEmailWindow(row.email));
  if (limited) return limited;

  const fullName = composeFullName(row.firstName, row.middleName, row.lastName, row.fullName);
  const issues = validateSubmitPayload({
    fullName,
    dob: row.dob,
    gender: row.gender,
    email: row.email,
    mobile: row.mobile,
    tinNo: row.tinNo,
    residentialAddress: (row.residentialAddress as { cityMunicipality?: string; province?: string } | null) ?? null,
    shareCapitalAmount: Number(row.shareCapitalAmount),
    shareCapitalPaid: row.shareCapitalPaid,
    membershipFeePaid: row.membershipFeePaid,
    paymentMode: row.paymentMode,
    gcashRefNo: row.gcashRefNo,
    dpaConsentAt: row.dpaConsentAt,
  });
  if (issues.length) return jsonError("Please fix the highlighted fields.", 400, { issues });
  if (row.referredByParticipantId) {
    const ok = await resolveApprovedReferrer(sql, row.referredByParticipantId);
    if (!ok) return jsonError("Referred by must be an approved member.", 400);
  }

  const dups = await evaluateDuplicates(
    { email: row.email, mobile: row.mobile, tinNo: row.tinNo, fullName, dob: row.dob, excludeApplicationId: row.id },
    duplicateLookup(sql),
  );
  const block = blockingFinding(dups);
  if (block) {
    return jsonError(block.message, 409, { code: block.action === "reclaim" ? "LEGACY_RECLAIM" : "DUPLICATE", kind: block.kind });
  }

  const dob = parseIsoDateOnly(row.dob);
  if (!dob) return jsonError("Date of birth is required.", 400);
  const dobIso = formatDobIso(dob);
  const mobile = normalizePhMobile(row.mobile);
  if (!mobile) return jsonError("Enter a Philippine mobile number.", 400);
  const tin = row.tinNo ? normalizeTinDigits(row.tinNo) : null;
  const mailing = formatMailingAddress(row.residentialAddress as never);

  let firebase;
  try {
    firebase = await createFirebaseMemberAccount(row.email, fullName);
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : "Firebase account creation failed", 400);
  }

  const otherUid = await sql`
    SELECT id FROM "Participant" WHERE "firebaseUid" = ${firebase.uid} AND email <> ${row.email} LIMIT 1
  `;
  if ((otherUid as { id: string }[]).length) {
    return jsonError("Already registered — sign in or reset password", 409);
  }

  const existing = await sql`SELECT id, "memberIdNo", "referredByParticipantId", "registrationSource" FROM "Participant" WHERE email = ${row.email} LIMIT 1`;
  const existingRow = (existing as { id: string; memberIdNo: string | null; referredByParticipantId: string | null; registrationSource: string | null }[])[0];
  const memberIdNo = existingRow?.memberIdNo || (await allocateMemberId(sql, fullName, row.firstName, row.lastName, dobIso));
  const participantId = existingRow?.id ?? crypto.randomUUID();
  const tinFlag = tin ? null : new Date();

  if (existingRow) {
    await sql`
      UPDATE "Participant" SET
        "fullName" = ${fullName},
        phone = ${mobile},
        dob = ${dobIso},
        gender = ${String(row.gender ?? "").trim()},
        "tinNo" = ${tin},
        "mailingAddress" = ${mailing || null},
        "firebaseUid" = ${firebase.uid},
        "memberIdNo" = ${memberIdNo},
        "referredByParticipantId" = COALESCE("referredByParticipantId", ${row.referredByParticipantId}),
        "tinMissingFlaggedAt" = ${tinFlag},
        "registrationSource" = COALESCE("registrationSource", 'online_form')
      WHERE id = ${existingRow.id}
    `;
  } else {
    await sql`
      INSERT INTO "Participant" (
        id, "fullName", email, phone, dob, gender, "tinNo", "mailingAddress", "firebaseUid",
        "memberIdNo", "referredByParticipantId", "tinMissingFlaggedAt", "registrationSource"
      ) VALUES (
        ${participantId}, ${fullName}, ${row.email}, ${mobile}, ${dobIso}, ${String(row.gender ?? "").trim()},
        ${tin}, ${mailing || null}, ${firebase.uid}, ${memberIdNo}, ${row.referredByParticipantId},
        ${tinFlag}, 'online_form'
      )
    `;
  }

  const newToken = await generateResumeToken();
  const newHash = await hashResumeToken(newToken);
  const updated = await sql`
    UPDATE "MembershipApplication" SET
      status = 'SUBMITTED',
      "participantId" = ${existingRow?.id ?? participantId},
      "fullName" = ${fullName},
      "submittedAt" = NOW(),
      "resumeTokenHash" = ${newHash},
      "possibleDuplicateOfId" = ${firstFlaggedParticipantId(dups)},
      "updatedAt" = NOW()
    WHERE id = ${row.id}
    RETURNING *
  `;
  const next = (updated as ApplicationRow[])[0]!;
  await sendMembershipEmail(
    setPasswordEmail({
      to: row.email,
      fullName,
      memberIdNo,
      setPasswordUrl: firebase.resetLink || `${publicAppUrl()}/set-password`,
    }),
  ).catch(() => undefined);
  await notifyTreasurers(sql, next, memberIdNo);
  return {
    ok: true as const,
    status: 200,
    body: {
      application: toPublicApplication(next),
      resumeToken: newToken,
      memberIdNo,
      participantId: existingRow?.id ?? participantId,
      needsTin: !tin,
      passwordEmailQueued: true,
    },
  };
}

export async function resendResume(id: string, token: string) {
  const sql = getSql();
  const loaded = await loadByToken(sql, id, token);
  if (loaded.error) return loaded.error;
  const next = await generateResumeToken();
  await sql`UPDATE "MembershipApplication" SET "resumeTokenHash" = ${await hashResumeToken(next)}, "updatedAt" = NOW() WHERE id = ${id}`;
  await sendMembershipEmail(
    resumeEmail({ to: loaded.row.email, continueUrl: `${publicAppUrl()}/register/continue?t=${encodeURIComponent(next)}` }),
  ).catch(() => undefined);
  return { ok: true as const, status: 200, body: { ok: true, resumeToken: next } };
}

export async function lookupReferrer(q: string, ip: string) {
  const sql = getSql();
  const limited = await consumeRate(sql, lookupIpWindow(ip));
  if (limited) return limited;
  const query = String(q ?? "").trim();
  if (query.length < 2) return { ok: true as const, status: 200, body: { results: [] } };
  const resolved = await resolveApprovedReferrer(sql, query);
  if (resolved) {
    const rows = await sql`SELECT "memberIdNo", "fullName" FROM "Participant" WHERE id = ${resolved} LIMIT 1`;
    const p = (rows as { memberIdNo: string | null; fullName: string }[])[0];
    if (p?.memberIdNo) {
      return { ok: true as const, status: 200, body: { results: [{ memberIdNo: p.memberIdNo, displayName: maskName(p.fullName), participantId: resolved }] } };
    }
  }
  const rows = await sql`
    SELECT id, "memberIdNo", "fullName" FROM "Participant"
    WHERE "boardApprovedAt" IS NOT NULL
      AND (
        "fullName" ILIKE ${`%${query}%`}
        OR "memberIdNo" ILIKE ${`%${query}%`}
        OR callsign ILIKE ${`%${query.toLowerCase()}%`}
      )
    LIMIT 8
  `;
  return {
    ok: true as const,
    status: 200,
    body: {
      results: (rows as { id: string; memberIdNo: string | null; fullName: string }[])
        .filter((r) => r.memberIdNo)
        .map((r) => ({ memberIdNo: r.memberIdNo as string, displayName: maskName(r.fullName), participantId: r.id })),
    },
  };
}

export async function attachScreenshot(id: string, token: string, key: string) {
  const sql = getSql();
  const loaded = await loadByToken(sql, id, token);
  if (loaded.error) return loaded.error;
  const updated = await sql`
    UPDATE "MembershipApplication"
    SET "gcashScreenshotKey" = ${key}, "paymentDeclaredAt" = NOW(), "updatedAt" = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  const next = (updated as ApplicationRow[])[0]!;
  if (next.status !== "DRAFT") await notifyTreasurers(sql, next);
  return { ok: true as const, status: 200, body: toPublicApplication(next) };
}

export async function runMembershipCron() {
  const sql = getSql();
  const cutoff = new Date(Date.now() - DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000);
  const expired = await sql`
    UPDATE "MembershipApplication"
    SET status = 'EXPIRED', "updatedAt" = NOW()
    WHERE status = 'DRAFT' AND "createdAt" < ${cutoff}
    RETURNING id
  `;
  const stale = await sql`
    SELECT id FROM "MembershipApplication"
    WHERE status = 'EXPIRED' AND "updatedAt" < ${cutoff}
    LIMIT 200
  `;
  const ids = (stale as { id: string }[]).map((r) => r.id);
  if (ids.length) {
    await sql`DELETE FROM "MembershipApplication" WHERE id = ANY(${ids})`;
  }
  const due = await sql`
    SELECT * FROM "MembershipApplication"
    WHERE status = 'SUBMITTED'
      AND ("shareCapitalPaid" = true OR "membershipFeePaid" = true)
      AND "paymentConfirmedAt" IS NULL
    LIMIT 100
  `;
  let reminded = 0;
  for (const row of due as ApplicationRow[]) {
    await notifyTreasurers(sql, row);
    reminded += 1;
  }
  return { expired: (expired as { id: string }[]).length, purged: ids.length, reminded };
}

export async function adminListApplications(query: { status?: string; q?: string }) {
  const sql = getSql();
  const status = query.status?.trim() || null;
  const q = query.q?.trim() || null;
  const rows = await sql`
    SELECT a.*, p."memberIdNo", p."initialFeesPaidAt", p."boardApprovedAt"
    FROM "MembershipApplication" a
    LEFT JOIN "Participant" p ON p.id = a."participantId"
    WHERE (${status}::text IS NULL OR a.status::text = ${status})
      AND (
        ${q}::text IS NULL
        OR a.email ILIKE ${q ? `%${q}%` : "%"}
        OR COALESCE(a."fullName", '') ILIKE ${q ? `%${q}%` : "%"}
        OR COALESCE(a.mobile, '') ILIKE ${q ? `%${q}%` : "%"}
      )
    ORDER BY a."updatedAt" DESC
    LIMIT 200
  `;
  const pending = await sql`
    SELECT COUNT(*)::int AS c FROM "MembershipApplication"
    WHERE status = 'SUBMITTED'
      AND ("shareCapitalPaid" = true OR "membershipFeePaid" = true)
      AND "paymentConfirmedAt" IS NULL
  `;
  return {
    applications: (rows as Array<ApplicationRow & { memberIdNo: string | null; initialFeesPaidAt: string | null; boardApprovedAt: string | null }>).map((r) => ({
      ...toPublicApplication(r),
      memberIdNo: r.memberIdNo,
      initialFeesPaidAt: r.initialFeesPaidAt,
      boardApprovedAt: r.boardApprovedAt,
      gcashScreenshotKey: r.gcashScreenshotKey,
    })),
    inbox: { paymentsToConfirm: Number((pending as { c: number }[])[0]?.c ?? 0) },
  };
}

export async function adminConfirmPayment(id: string, staff: { sub: string; role: string }, receiptNo?: string) {
  if (!["superuser", "admin", "treasurer"].includes(staff.role)) {
    return jsonError("Only Treasurer (or Admin / Superuser) can confirm payment.", 403);
  }
  const sql = getSql();
  const rows = await sql`SELECT * FROM "MembershipApplication" WHERE id = ${id} LIMIT 1`;
  const row = (rows as ApplicationRow[])[0];
  if (!row?.participantId) return jsonError("Submitted application not found", 404);
  const beforeRows = await sql`
    SELECT id, email, "memberIdNo", "fullName", "initialFeesPaidAt"
    FROM "Participant" WHERE id = ${row.participantId} LIMIT 1
  `;
  const before = (beforeRows as { id: string; email: string; memberIdNo: string | null; fullName: string; initialFeesPaidAt: Date | null }[])[0];
  if (!before) return jsonError("Participant not found", 404);
  await sql`UPDATE "Participant" SET "initialFeesPaidAt" = COALESCE("initialFeesPaidAt", NOW()) WHERE id = ${before.id}`;
  const updated = await sql`
    UPDATE "MembershipApplication"
    SET status = 'PAYMENT_CONFIRMED', "paymentConfirmedAt" = NOW(), "paymentConfirmedById" = ${staff.sub},
        "receiptNo" = ${receiptNo?.trim() || null}, "updatedAt" = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  let accountingInitialFees = null;
  if (!before.initialFeesPaidAt) {
    accountingInitialFees = await postInitialFeesPaidAwait({
      participantId: before.id,
      memberIdNo: before.memberIdNo,
      email: before.email,
      fullName: before.fullName,
    });
  }
  return {
    ok: true as const,
    status: 200,
    body: { application: toPublicApplication((updated as ApplicationRow[])[0]!), accountingInitialFees },
  };
}

export async function adminReject(id: string, staff: { role: string }, reason: string) {
  if (!["superuser", "secretary"].includes(staff.role)) {
    return jsonError("Only the Secretary (or Superuser) may reject an application.", 403);
  }
  const why = reason.trim();
  if (!why) return jsonError("rejectionReason is required", 400);
  const sql = getSql();
  const updated = await sql`
    UPDATE "MembershipApplication"
    SET status = 'REJECTED', "rejectedAt" = NOW(), "rejectionReason" = ${why.slice(0, 1000)}, "updatedAt" = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  const row = (updated as ApplicationRow[])[0];
  if (!row) return jsonError("Application not found", 404);
  await sendMembershipEmail(rejectedEmail({ to: row.email, fullName: row.fullName || row.email, reason: why })).catch(() => undefined);
  return { ok: true as const, status: 200, body: toPublicApplication(row) };
}

export async function adminPatchReferrer(id: string, staff: { role: string }, referrerId: string | null) {
  if (!["superuser", "secretary"].includes(staff.role)) {
    return jsonError("Only the Secretary (or Superuser) may correct the referrer.", 403);
  }
  const sql = getSql();
  const rows = await sql`SELECT * FROM "MembershipApplication" WHERE id = ${id} LIMIT 1`;
  const row = (rows as ApplicationRow[])[0];
  if (!row) return jsonError("Application not found", 404);
  if (row.status === "APPROVED") return jsonError("Referrer can only be corrected before approval.", 400);
  const resolved = referrerId ? await resolveApprovedReferrer(sql, referrerId) : null;
  if (referrerId && !resolved) return jsonError("Referred by must be an approved member.", 400);
  const updated = await sql`
    UPDATE "MembershipApplication" SET "referredByParticipantId" = ${resolved}, "updatedAt" = NOW()
    WHERE id = ${id} RETURNING *
  `;
  if (row.participantId) {
    await sql`UPDATE "Participant" SET "referredByParticipantId" = ${resolved} WHERE id = ${row.participantId}`;
  }
  return { ok: true as const, status: 200, body: toPublicApplication((updated as ApplicationRow[])[0]!) };
}

export async function syncApplicationFromParticipant(participantId: string) {
  const sql = getSql();
  const pRows = await sql`
    SELECT "initialFeesPaidAt", "bodMajorityReachedAt", "boardApprovedAt", email, "fullName", "memberIdNo"
    FROM "Participant" WHERE id = ${participantId} LIMIT 1
  `;
  const p = (pRows as {
    initialFeesPaidAt: string | null;
    bodMajorityReachedAt: string | null;
    boardApprovedAt: string | null;
    email: string;
    fullName: string;
    memberIdNo: string | null;
  }[])[0];
  if (!p) return;
  const aRows = await sql`SELECT id, status FROM "MembershipApplication" WHERE "participantId" = ${participantId} LIMIT 1`;
  const app = (aRows as { id: string; status: "DRAFT" | "SUBMITTED" | "PAYMENT_CONFIRMED" | "BOD_APPROVED" | "APPROVED" | "REJECTED" | "WITHDRAWN" | "EXPIRED" }[])[0];
  if (!app) return;
  const derived = derivedApplicationStatus(p);
  const next = nextStatusAfterLifecycle(app.status, derived);
  if (next !== app.status) {
    await sql`UPDATE "MembershipApplication" SET status = ${next}::"MembershipApplicationStatus", "updatedAt" = NOW() WHERE id = ${app.id}`;
    if (next === "APPROVED" && p.memberIdNo) {
      await sendMembershipEmail(approvedEmail({ to: p.email, fullName: p.fullName, memberIdNo: p.memberIdNo })).catch(() => undefined);
    }
  }
}
