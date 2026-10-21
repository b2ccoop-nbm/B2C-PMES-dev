import { describe, expect, it } from "vitest";
import { authorizeCronSecret } from "./cron-auth";
import { publicCreateForExistingApplication } from "./existing-draft-policy";
import { forcePmesOverrideAudit } from "./pmes-gate";
import { referrerConflictMessage } from "./referrer-rules";
import { detectImageMime, generateUploadKey, validateScreenshotBytes } from "./screenshot";
import { continueUrl, isResumeTokenExpired, resumeCookie } from "./tokens";
import { turnstileCanSkip } from "./turnstile";
import { isValidEmail } from "./validators";
import { canAccessMembershipApplications, membershipScreenshotPath } from "./staff-access";
import { toPublicApplication, type ApplicationRow } from "./edge-service";
import { allowedCorsOrigins, isAllowedCorsOrigin } from "../edge-cors";

describe("Worker QA D must-fixes", () => {
  it("C1: existing email create is generic and does not rotate or leak PII", () => {
    const draft = publicCreateForExistingApplication("DRAFT");
    const submitted = publicCreateForExistingApplication("SUBMITTED");
    expect(draft.rotateToken).toBe(false);
    expect(draft.returnPii).toBe(false);
    expect(draft.emailContinue).toBe(true);
    expect(submitted.emailContinue).toBe(false);
  });

  it("C2: cron fails closed when the secret is unset or wrong", () => {
    expect(authorizeCronSecret("", "x").ok).toBe(false);
    expect(authorizeCronSecret("secret", "nope").ok).toBe(false);
    expect(authorizeCronSecret("secret", "secret").ok).toBe(true);
  });

  it("H1/H6: Worker email validation rejects empty values", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("ok@b2ccoop.com")).toBe(true);
  });

  it("H2: resume claims stay in the hash and cookies are HttpOnly", () => {
    expect(continueUrl("https://b2ccoop.com", "tok")).toContain("#c=");
    expect(continueUrl("https://b2ccoop.com", "tok")).not.toContain("?t=");
    expect(resumeCookie("tok", { secure: true })).toMatch(/HttpOnly/);
    expect(isResumeTokenExpired(null)).toBe(true);
  });

  it("H3: Turnstile does not skip in production", () => {
    expect(turnstileCanSkip({ NODE_ENV: "production" })).toBe(false);
  });

  it("H4: upload magic bytes and server-generated keys", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(detectImageMime(jpeg)).toBe("image/jpeg");
    expect(validateScreenshotBytes(new Uint8Array([1, 2, 3])).ok).toBe(false);
    expect(generateUploadKey("app", "image/webp")).toMatch(/^membership\/app\//);
  });

  it("H8: force override audit is emitted for superuser only", () => {
    expect(forcePmesOverrideAudit({ participantId: "p", actorRole: "superuser", force: true, pmesPassed: false }).shouldLog).toBe(true);
    expect(forcePmesOverrideAudit({ participantId: "p", actorRole: "secretary", force: true, pmesPassed: false }).shouldLog).toBe(false);
  });

  it("D6: self and same-email referrers are rejected", () => {
    expect(referrerConflictMessage({ referrerId: "a", applicantParticipantId: "a" })).toMatch(/yourself/);
    expect(referrerConflictMessage({ referrerId: "b", referrerEmail: "x@y.com", applicantEmail: "x@y.com" })).toMatch(/same email/);
  });

  it("CORS is allowlisted", () => {
    expect(isAllowedCorsOrigin("https://evil.example")).toBe(false);
    expect(allowedCorsOrigins()).toContain("https://b2ccoop.com");
  });

  it("H7: public payloads omit possibleDuplicateOfId and raw screenshot keys", () => {
    const row = {
      id: "app-1",
      status: "DRAFT",
      resumeTokenHash: "hash",
      participantId: null,
      fullName: "A",
      firstName: "A",
      middleName: null,
      lastName: "B",
      dob: "1990-01-01",
      gender: "female",
      email: "a@test.com",
      mobile: "+639171234567",
      tinNo: "123456789",
      residentialAddress: null,
      referredByParticipantId: null,
      shareCapitalAmount: 1000,
      shareCapitalPaid: false,
      membershipFeeAmount: 500,
      membershipFeePaid: false,
      paymentMode: null,
      gcashRefNo: null,
      gcashScreenshotKey: "membership/app-1/secret.webp",
      paymentDeclaredAt: null,
      possibleDuplicateOfId: "other-member",
      submittedAt: null,
      dpaConsentAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    } as ApplicationRow;
    const pub = toPublicApplication(row);
    expect(pub).not.toHaveProperty("possibleDuplicateOfId");
    expect(pub).not.toHaveProperty("gcashScreenshotKey");
    expect(pub.hasGcashScreenshot).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("secret.webp");
    expect(JSON.stringify(pub)).not.toContain("other-member");
  });

  it("H7: admin list is treasurer/secretary/superuser and screenshot URL is authorized", () => {
    expect(canAccessMembershipApplications("treasurer")).toBe(true);
    expect(canAccessMembershipApplications("secretary")).toBe(true);
    expect(canAccessMembershipApplications("superuser")).toBe(true);
    expect(canAccessMembershipApplications("admin")).toBe(false);
    expect(canAccessMembershipApplications("board_director")).toBe(false);
    expect(membershipScreenshotPath("app-9")).toBe("/pmes/admin/membership-applications/app-9/screenshot");
  });
});
