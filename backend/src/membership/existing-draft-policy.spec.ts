import { EXISTING_APPLICATION_MESSAGE, publicCreateForExistingApplication } from "./existing-draft-policy";

describe("public create existing-application policy", () => {
  it("never rotates a token, returns PII, or issues a continue link", () => {
    for (const status of ["DRAFT", "SUBMITTED", "APPROVED"]) {
      const policy = publicCreateForExistingApplication(status);
      expect(policy.rotateToken).toBe(false);
      expect(policy.returnPii).toBe(false);
      expect(policy.issueContinue).toBe(false);
      expect(policy.message).toBe(EXISTING_APPLICATION_MESSAGE);
      expect(policy.message).not.toMatch(/check your email|emailed/i);
    }
  });
});
