/** Roles that may list online applications and fetch GCash screenshots. */
export const MEMBERSHIP_ADMIN_ROLES = ["treasurer", "secretary", "superuser"] as const;

export function canAccessMembershipApplications(role: string | null | undefined): boolean {
  return (MEMBERSHIP_ADMIN_ROLES as readonly string[]).includes(String(role ?? ""));
}

export function membershipScreenshotPath(applicationId: string): string {
  return `/pmes/admin/membership-applications/${applicationId}/screenshot`;
}
