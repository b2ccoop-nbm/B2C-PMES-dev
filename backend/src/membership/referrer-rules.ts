import { normalizeEmail, normalizePhMobile } from "./validators";

export function referrerConflictMessage(input: {
  referrerId: string;
  referrerEmail?: string | null;
  referrerPhone?: string | null;
  applicantParticipantId?: string | null;
  applicantEmail?: string | null;
  applicantMobile?: string | null;
}): string | null {
  if (input.applicantParticipantId && input.referrerId === input.applicantParticipantId) {
    return "You cannot refer yourself.";
  }
  const applicantEmail = normalizeEmail(input.applicantEmail ?? "");
  const referrerEmail = normalizeEmail(input.referrerEmail ?? "");
  if (applicantEmail && referrerEmail && applicantEmail === referrerEmail) {
    return "Referrer cannot use the same email as the applicant.";
  }
  const applicantMobile = normalizePhMobile(input.applicantMobile);
  const referrerPhone = normalizePhMobile(input.referrerPhone);
  if (applicantMobile && referrerPhone && applicantMobile === referrerPhone) {
    return "Referrer cannot use the same mobile number as the applicant.";
  }
  return null;
}
