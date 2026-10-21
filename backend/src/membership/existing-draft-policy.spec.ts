import { publicCreateForExistingApplication } from "./existing-draft-policy";

describe("public create existing-application policy", () => {
  it("never rotates a token or returns PII", () => {
    for (const status of ["DRAFT", "SUBMITTED", "APPROVED"]) {
      const policy = publicCreateForExistingApplication(status);
      expect(policy.rotateToken).toBe(false);
      expect(policy.returnPii).toBe(false);
      expect(policy.message).toMatch(/check your email/i);
    }
  });

  it("emails a continue link only for drafts", () => {
    expect(publicCreateForExistingApplication("DRAFT").emailContinue).toBe(true);
    expect(publicCreateForExistingApplication("SUBMITTED").emailContinue).toBe(false);
  });
});
