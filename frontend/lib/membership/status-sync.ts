export type ApplicationStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "PAYMENT_CONFIRMED"
  | "BOD_APPROVED"
  | "APPROVED"
  | "REJECTED"
  | "WITHDRAWN"
  | "EXPIRED";

export function derivedApplicationStatus(participant: {
  initialFeesPaidAt?: Date | string | null;
  bodMajorityReachedAt?: Date | string | null;
  boardApprovedAt?: Date | string | null;
}): ApplicationStatus | null {
  if (participant.boardApprovedAt) return "APPROVED";
  if (participant.bodMajorityReachedAt) return "BOD_APPROVED";
  if (participant.initialFeesPaidAt) return "PAYMENT_CONFIRMED";
  return null;
}

export function nextStatusAfterLifecycle(current: ApplicationStatus, derived: ApplicationStatus | null): ApplicationStatus {
  if (current === "REJECTED" || current === "WITHDRAWN" || current === "EXPIRED") return current;
  if (!derived) return current;
  const rank: Record<ApplicationStatus, number> = {
    DRAFT: 0,
    SUBMITTED: 1,
    PAYMENT_CONFIRMED: 2,
    BOD_APPROVED: 3,
    APPROVED: 4,
    REJECTED: 0,
    WITHDRAWN: 0,
    EXPIRED: 0,
  };
  return rank[derived] > rank[current] ? derived : current;
}
