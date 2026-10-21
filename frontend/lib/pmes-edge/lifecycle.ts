import {
  buildMemberPublicId,
  cohortYYFromDob,
  initialsFromFirstLast,
  initialsFromFullName,
} from "@/lib/pmes-edge/member-public-id";
import { computeAlternatePublicHandle } from "@/lib/pmes-edge/callsign";
import { digitsOnly, isNineDigitTinPlaceholderInMemberIdSlot, normalizeEmail } from "@/lib/pmes-edge/norm";
import {
  loadParticipantWithRelsById,
  type ParticipantWithRels,
} from "@/lib/pmes-edge/queries";
import { getSql } from "@/lib/db";
import { BOD_DIRECTOR_SEATS, BOD_MAJORITY_APPROVALS } from "@/lib/pmes-edge/board-workflow.constants";

type Sql = ReturnType<typeof getSql>;

export type MembershipStage =
  | "NO_PARTICIPANT"
  | "PMES_NOT_PASSED"
  | "AWAITING_LOI"
  | "AWAITING_PAYMENT"
  | "AWAITING_BOD_VOTE"
  | "AWAITING_SECRETARY_RESOLUTION"
  | "AWAITING_FULL_PROFILE"
  | "FULL_MEMBER";

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function toLifecyclePayload(participant: ParticipantWithRels) {
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
    profileRecordVersion: participant.memberProfileConcurrencyStamp ?? 0,
    isLegacyFounderImport: participant.legacyPioneerImport,
    memberIdNo: participant.memberIdNo,
    callsign: participant.callsign,
    alternatePublicHandle: computeAlternatePublicHandle({
      callsign: participant.callsign,
      lastNameKey: participant.lastNameKey,
      lastNameSeq: participant.lastNameSeq,
    }),
    memberIdIsProvisional: !profile,
    registrationFullName: participant.fullName,
    registrationDob: participant.dob,
    registrationGender: participant.gender,
    registrationPhone: participant.phone,
    bodApproveVoteCount: fees ? participant.bodApproveVoteCount : 0,
    bodMajorityReached: fees && bodMajority,
    bodMajorityRequired: BOD_MAJORITY_APPROVALS,
    bodDirectorSeats: BOD_DIRECTOR_SEATS,
    boardResolutionNo: participant.boardResolutionNo ?? null,
    needsTin: !String(participant.tinNo ?? "").trim(),
    tinMissingFlaggedAt: participant.tinMissingFlaggedAt ?? null,
  };
}

export function noParticipantLifecycle(email: string) {
  const referralRewards = {
    successfulJoinCount: 0,
    pioneerPoints: 0,
    invitesThisMonth: 0,
  };
  return {
    participantId: null as string | null,
    email: normalizeEmail(email),
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
    referralRewards,
    bodApproveVoteCount: 0,
    bodMajorityReached: false,
    bodMajorityRequired: BOD_MAJORITY_APPROVALS,
    bodDirectorSeats: BOD_DIRECTOR_SEATS,
    boardResolutionNo: null as string | null,
    needsTin: false,
    tinMissingFlaggedAt: null as string | Date | null,
  };
}

/**
 * Mirrors Nest `PmesService.ensureMemberPublicId` (provisional B2C- ID) using raw SQL.
 */
export async function ensureMemberPublicId(sql: Sql, participant: ParticipantWithRels, profile?: unknown) {
  let p = participant;

  if (isNineDigitTinPlaceholderInMemberIdSlot(p.legacyPioneerImport, p.memberIdNo)) {
    const tin = digitsOnly(p.memberIdNo);
    const tinVal = p.tinNo?.trim() || tin;
    await sql`
      UPDATE "Participant"
      SET "tinNo" = ${tinVal}, "memberIdNo" = NULL
      WHERE id = ${p.id}
    `;
    const reloaded = await loadParticipantWithRelsById(sql, p.id);
    if (!reloaded) {
      throw new Error("Failed to reload participant after TIN migration");
    }
    p = reloaded;
  }

  if (String(p.memberIdNo ?? "").trim()) {
    return p;
  }

  let initials = initialsFromFullName(p.fullName);
  let yy = cohortYYFromDob(p.dob, p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt));

  const root = profile ? asObject(profile) : null;
  const personal = root ? asObject(root.personal) : null;
  if (personal) {
    const fn = typeof personal.firstName === "string" ? personal.firstName : "";
    const ln = typeof personal.lastName === "string" ? personal.lastName : "";
    if (fn.trim() && ln.trim()) {
      initials = initialsFromFirstLast(fn, ln, p.fullName);
    }
    const bd = typeof personal.birthDate === "string" ? personal.birthDate : "";
    if (bd.trim()) {
      yy = cohortYYFromDob(bd, p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt));
    }
  }

  for (let attempt = 0; attempt < 16; attempt++) {
    const id = buildMemberPublicId(initials, yy);
    const clash = await sql`
      SELECT id FROM "Participant"
      WHERE "memberIdNo" = ${id} AND id <> ${p.id}
      LIMIT 1
    `;
    if ((clash as { id: string }[]).length > 0) continue;

    await sql`
      UPDATE "Participant" SET "memberIdNo" = ${id} WHERE id = ${p.id}
    `;
    const reloaded = await loadParticipantWithRelsById(sql, p.id);
    if (!reloaded) {
      throw new Error("Failed to reload participant after member ID assignment");
    }
    return reloaded;
  }

  throw new Error("Could not allocate a unique member ID after retries.");
}
