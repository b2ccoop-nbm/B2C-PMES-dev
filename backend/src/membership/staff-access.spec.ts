import { canAccessMembershipApplications, membershipScreenshotPath } from "./staff-access";

describe("membership admin staff access", () => {
  it("allows treasurer, secretary, and superuser only", () => {
    expect(canAccessMembershipApplications("treasurer")).toBe(true);
    expect(canAccessMembershipApplications("secretary")).toBe(true);
    expect(canAccessMembershipApplications("superuser")).toBe(true);
    expect(canAccessMembershipApplications("admin")).toBe(false);
    expect(canAccessMembershipApplications("board_director")).toBe(false);
    expect(canAccessMembershipApplications("")).toBe(false);
  });

  it("builds an authorized screenshot path without a storage key", () => {
    expect(membershipScreenshotPath("app-1")).toBe("/pmes/admin/membership-applications/app-1/screenshot");
    expect(membershipScreenshotPath("app-1")).not.toMatch(/r2|mock:/);
  });
});
