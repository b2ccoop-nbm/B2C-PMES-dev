import { BOD_DIRECTOR_SEATS, BOD_MAJORITY_APPROVALS } from "@/lib/pmes-edge/board-workflow.constants";

export type AdminLifecycleRow = {
  id: string;
  /** Participant row creation (member since). */
  createdAt?: string | Date | null;
  email: string;
  legacyPioneerImport: boolean | null;
  memberIdNo: string | null;
  memberProfileConcurrencyStamp: number;
  callsign: string | null;
  lastNameKey: string | null;
  lastNameSeq: number | null;
  fullName: string;
  dob: string;
  gender: string;
  phone: string;
  pmesPassed: boolean;
  loiSubmitted: boolean;
  initialFeesPaidAt: string | null;
  bodMajorityReachedAt: string | null;
  boardResolutionNo: string | null;
  /** Yes votes from `BoardApprovalVote` (filled when column/query present). */
  bodApproveVoteCount?: number | null;
  boardApprovedAt: string | null;
  fullProfileCompletedAt: string | null;
  tinNo?: string | null;
  tinMissingFlaggedAt?: string | Date | null;
};

function computeAlternatePublicHandle(input: {
  callsign: string | null;
  lastNameKey: string | null;
  lastNameSeq: number | null;
}): string | null {
  if (input.callsign?.trim()) return input.callsign.trim();
  if (input.lastNameKey?.trim() && Number.isFinite(input.lastNameSeq) && (input.lastNameSeq ?? 0) > 0) {
    return `${input.lastNameKey.trim()}-${input.lastNameSeq}`;
  }
  return null;
}

export function toLifecyclePayload(row: AdminLifecycleRow) {
  const fees = Boolean(row.initialFeesPaidAt);
  const board = Boolean(row.boardApprovedAt);
  const profile = Boolean(row.fullProfileCompletedAt);
  const bodMajority = Boolean(row.bodMajorityReachedAt);
  let stage:
    | "PMES_NOT_PASSED"
    | "AWAITING_LOI"
    | "AWAITING_PAYMENT"
    | "AWAITING_BOD_VOTE"
    | "AWAITING_SECRETARY_RESOLUTION"
    | "AWAITING_FULL_PROFILE"
    | "FULL_MEMBER";
  if (!row.pmesPassed) stage = "PMES_NOT_PASSED";
  else if (!row.loiSubmitted) stage = "AWAITING_LOI";
  else if (!fees) stage = "AWAITING_PAYMENT";
  else if (board) {
    if (!profile) stage = "AWAITING_FULL_PROFILE";
    else stage = "FULL_MEMBER";
  } else if (bodMajority) stage = "AWAITING_SECRETARY_RESOLUTION";
  else stage = "AWAITING_BOD_VOTE";
  return {
    participantId: row.id,
    email: row.email,
    stage,
    pmEsPassed: row.pmesPassed,
    loiSubmitted: row.loiSubmitted,
    initialFeesPaid: fees,
    boardApproved: board,
    fullProfileCompleted: profile,
    canAccessFullMemberPortal: stage === "FULL_MEMBER",
    profileRecordVersion: row.memberProfileConcurrencyStamp ?? 0,
    isLegacyFounderImport: Boolean(row.legacyPioneerImport),
    memberIdNo: row.memberIdNo,
    callsign: row.callsign,
    alternatePublicHandle: computeAlternatePublicHandle({
      callsign: row.callsign,
      lastNameKey: row.lastNameKey,
      lastNameSeq: row.lastNameSeq,
    }),
    memberIdIsProvisional: !profile,
    registrationFullName: row.fullName,
    registrationDob: row.dob,
    registrationGender: row.gender,
    registrationPhone: row.phone,
    bodApproveVoteCount: fees
      ? typeof row.bodApproveVoteCount === "number"
        ? row.bodApproveVoteCount
        : 0
      : 0,
    bodMajorityReached: fees && bodMajority,
    bodMajorityRequired: BOD_MAJORITY_APPROVALS,
    bodDirectorSeats: BOD_DIRECTOR_SEATS,
    boardResolutionNo: row.boardResolutionNo,
    needsTin: !String(row.tinNo ?? "").trim(),
    tinMissingFlaggedAt: row.tinMissingFlaggedAt ?? null,
  };
}
