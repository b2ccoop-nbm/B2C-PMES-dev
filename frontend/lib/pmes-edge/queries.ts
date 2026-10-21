import { getSql } from "@/lib/db";
import { isMissingMemberProfileStampColumnError } from "@/lib/pmes-edge/pg-stamp-fallback";

type Sql = ReturnType<typeof getSql>;

export type ParticipantCore = {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  dob: string;
  gender: string;
  createdAt: string | Date;
  legacyPioneerImport: boolean;
  memberIdNo: string | null;
  tinNo: string | null;
  tinMissingFlaggedAt?: string | Date | null;
  initialFeesPaidAt: string | Date | null;
  bodMajorityReachedAt: string | Date | null;
  boardResolutionNo: string | null;
  boardApprovedAt: string | Date | null;
  fullProfileCompletedAt: string | Date | null;
  memberProfileConcurrencyStamp: number;
  callsign: string | null;
  lastNameKey: string | null;
  lastNameSeq: number | null;
};

export type PmesRecordRow = {
  id: string;
  score: number;
  passed: boolean;
  timestamp: string | Date;
};

export type LoiSubmissionRow = { id: string } | null;

export type ParticipantWithRels = ParticipantCore & {
  pmesRecords: PmesRecordRow[];
  loiSubmission: LoiSubmissionRow;
  bodApproveVoteCount: number;
};

function toDate(d: string | Date): Date {
  return d instanceof Date ? d : new Date(d);
}

export async function loadParticipantWithRelsByEmail(
  sql: Sql,
  email: string,
): Promise<ParticipantWithRels | null> {
  let rows: unknown[];
  try {
    rows = await sql`
      SELECT
        id, "fullName", email, phone, dob, gender, "createdAt",
        "legacyPioneerImport", "memberIdNo", "tinNo",
        "initialFeesPaidAt", "bodMajorityReachedAt", "boardResolutionNo", "boardApprovedAt", "fullProfileCompletedAt",
        "memberProfileConcurrencyStamp",
        callsign, "lastNameKey", "lastNameSeq"
      FROM "Participant"
      WHERE email = ${email}
      LIMIT 1
    `;
  } catch (e) {
    if (!isMissingMemberProfileStampColumnError(e)) throw e;
    rows = await sql`
      SELECT
        id, "fullName", email, phone, dob, gender, "createdAt",
        "legacyPioneerImport", "memberIdNo", "tinNo",
        "initialFeesPaidAt", "boardApprovedAt", "fullProfileCompletedAt",
        callsign, "lastNameKey", "lastNameSeq"
      FROM "Participant"
      WHERE email = ${email}
      LIMIT 1
    `;
  }
  const raw = (rows as Omit<ParticipantCore, "memberProfileConcurrencyStamp">[])[0];
  if (!raw) return null;
  const r = raw as {
    bodMajorityReachedAt?: string | Date | null;
    boardResolutionNo?: string | null;
  };
  const p: ParticipantCore = {
    ...raw,
    bodMajorityReachedAt: r.bodMajorityReachedAt ?? null,
    boardResolutionNo: r.boardResolutionNo ?? null,
    memberProfileConcurrencyStamp:
      typeof (raw as ParticipantCore).memberProfileConcurrencyStamp === "number"
        ? (raw as ParticipantCore).memberProfileConcurrencyStamp
        : 0,
  };
  return loadRelationsForParticipant(sql, p);
}

export async function loadParticipantWithRelsById(
  sql: Sql,
  id: string,
): Promise<ParticipantWithRels | null> {
  let rows: unknown[];
  try {
    rows = await sql`
      SELECT
        id, "fullName", email, phone, dob, gender, "createdAt",
        "legacyPioneerImport", "memberIdNo", "tinNo",
        "initialFeesPaidAt", "bodMajorityReachedAt", "boardResolutionNo", "boardApprovedAt", "fullProfileCompletedAt",
        "memberProfileConcurrencyStamp",
        callsign, "lastNameKey", "lastNameSeq"
      FROM "Participant"
      WHERE id = ${id}
      LIMIT 1
    `;
  } catch (e) {
    if (!isMissingMemberProfileStampColumnError(e)) throw e;
    rows = await sql`
      SELECT
        id, "fullName", email, phone, dob, gender, "createdAt",
        "legacyPioneerImport", "memberIdNo", "tinNo",
        "initialFeesPaidAt", "boardApprovedAt", "fullProfileCompletedAt",
        callsign, "lastNameKey", "lastNameSeq"
      FROM "Participant"
      WHERE id = ${id}
      LIMIT 1
    `;
  }
  const raw = (rows as Omit<ParticipantCore, "memberProfileConcurrencyStamp">[])[0];
  if (!raw) return null;
  const r = raw as {
    bodMajorityReachedAt?: string | Date | null;
    boardResolutionNo?: string | null;
  };
  const p: ParticipantCore = {
    ...raw,
    bodMajorityReachedAt: r.bodMajorityReachedAt ?? null,
    boardResolutionNo: r.boardResolutionNo ?? null,
    memberProfileConcurrencyStamp:
      typeof (raw as ParticipantCore).memberProfileConcurrencyStamp === "number"
        ? (raw as ParticipantCore).memberProfileConcurrencyStamp
        : 0,
  };
  return loadRelationsForParticipant(sql, p);
}

async function loadRelationsForParticipant(
  sql: Sql,
  p: ParticipantCore,
): Promise<ParticipantWithRels> {
  const pr = await sql`
    SELECT id, score, passed, "timestamp"
    FROM "PmesRecord"
    WHERE "participantId" = ${p.id}
    ORDER BY "timestamp" DESC
  `;
  const loiRows = await sql`
    SELECT id FROM "LoiSubmission" WHERE "participantId" = ${p.id} LIMIT 1
  `;
  const loi = (loiRows as { id: string }[])[0] ?? null;
  let bodApproveVoteCount = 0;
  try {
    const voteRows = await sql`
      SELECT COUNT(*)::int AS n
      FROM "BoardApprovalVote"
      WHERE "participantId" = ${p.id} AND approve = true
    `;
    bodApproveVoteCount = Number((voteRows as { n: number }[])[0]?.n ?? 0);
  } catch (e) {
    const code = typeof (e as { code?: string })?.code === "string" ? (e as { code: string }).code : "";
    const msg = e instanceof Error ? e.message : String(e ?? "");
    if (code !== "42P01" && !/BoardApprovalVote/i.test(msg)) throw e;
  }
  return {
    ...p,
    createdAt: toDate(p.createdAt as string | Date),
    initialFeesPaidAt: p.initialFeesPaidAt ? toDate(p.initialFeesPaidAt as string | Date) : null,
    bodMajorityReachedAt: p.bodMajorityReachedAt ? toDate(p.bodMajorityReachedAt as string | Date) : null,
    boardResolutionNo: p.boardResolutionNo ?? null,
    boardApprovedAt: p.boardApprovedAt ? toDate(p.boardApprovedAt as string | Date) : null,
    fullProfileCompletedAt: p.fullProfileCompletedAt
      ? toDate(p.fullProfileCompletedAt as string | Date)
      : null,
    pmesRecords: (pr as PmesRecordRow[]).map((r) => ({
      ...r,
      timestamp: toDate(r.timestamp as string | Date),
    })),
    loiSubmission: loi,
    bodApproveVoteCount,
  };
}
