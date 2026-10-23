import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashResumeToken } from "./tokens";

const firebase = vi.hoisted(() => ({
  createFirebaseMemberAccount: vi.fn(),
  deleteFirebaseMemberAccount: vi.fn(),
}));

vi.mock("@/lib/membership/firebase-signup", () => ({
  createFirebaseMemberAccount: firebase.createFirebaseMemberAccount,
  deleteFirebaseMemberAccount: firebase.deleteFirebaseMemberAccount,
}));

type Query = { text: string; values: unknown[] };

const db = vi.hoisted(() => {
  const state = {
    queries: [] as Query[],
    persistFailAt: null as null | "participant" | "application",
    insertedParticipants: 0,
    deletedParticipants: 0,
    submitted: 0,
    revertedToDraft: 0,
    application: null as Record<string, unknown> | null,
  };

  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    state.queries.push({ text, values });

    if (/INSERT INTO "MembershipRateLimit"/.test(text)) return [{ count: 1 }];
    if (/SELECT \* FROM "MembershipApplication" WHERE id/.test(text)) return [state.application];
    if (/FROM "MembershipApplication"/.test(text) && /status IN/.test(text)) return [state.application];
    if (/FROM "Participant" WHERE email/.test(text)) return [];
    if (/FROM "Participant" WHERE phone/.test(text)) return [];
    if (/FROM "Participant" WHERE "tinNo"/.test(text)) return [];
    if (/FROM "Participant" WHERE dob/.test(text)) return [];
    if (/FROM "Participant" WHERE "memberIdNo"/.test(text)) return [];
    if (/FROM "Participant" WHERE "firebaseUid"/.test(text)) return [];
    if (/INSERT INTO "Participant"/.test(text)) {
      if (state.persistFailAt === "participant") throw new Error("participant insert failed");
      state.insertedParticipants += 1;
      return [];
    }
    if (/UPDATE "Participant"/.test(text)) return [];
    if (/DELETE FROM "Participant"/.test(text)) {
      state.deletedParticipants += 1;
      state.insertedParticipants = Math.max(0, state.insertedParticipants - 1);
      return [];
    }
    if (/UPDATE "MembershipApplication"/.test(text) && /SUBMITTED/.test(text)) {
      if (state.persistFailAt === "application") throw new Error("application submit failed");
      state.submitted += 1;
      return [{ ...state.application, status: "SUBMITTED", participantId: values[0], submittedAt: new Date() }];
    }
    if (/UPDATE "MembershipApplication"/.test(text) && /DRAFT/.test(text)) {
      state.revertedToDraft += 1;
      if (state.application) {
        state.application = { ...state.application, status: "DRAFT", participantId: null, submittedAt: null };
      }
      return [];
    }
    if (/treasurerNotifiedAt/.test(text)) return [];
    return [];
  };

  return { state, sql };
});

vi.mock("@/lib/db", () => ({
  getSql: () => db.sql,
}));

function draftApplication(tokenHash: string) {
  return {
    id: "app-1",
    status: "DRAFT",
    resumeTokenHash: tokenHash,
    resumeTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    pendingResumeTokenHash: null,
    pendingResumeTokenExpiresAt: null,
    participantId: null,
    fullName: "Juan Dela Cruz",
    firstName: "Juan",
    middleName: null,
    lastName: "Cruz",
    dob: "1990-01-15",
    gender: "male",
    email: "juan@example.com",
    mobile: "+639171234567",
    tinNo: "123456789",
    residentialAddress: { street: "1 Mabini", barangay: "Lahug", cityMunicipality: "Cebu City", province: "Cebu", zip: "6000" },
    referredByParticipantId: null,
    shareCapitalAmount: 1000,
    shareCapitalPaid: false,
    membershipFeeAmount: 500,
    membershipFeePaid: false,
    paymentMode: null,
    gcashRefNo: null,
    gcashScreenshotKey: null,
    paymentDeclaredAt: null,
    possibleDuplicateOfId: null,
    submittedAt: null,
    dpaConsentAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

describe("submitDraft Firebase compensation", () => {
  beforeEach(() => {
    db.state.queries = [];
    db.state.persistFailAt = null;
    db.state.insertedParticipants = 0;
    db.state.deletedParticipants = 0;
    db.state.submitted = 0;
    db.state.revertedToDraft = 0;
    db.state.application = null;
    firebase.createFirebaseMemberAccount.mockReset();
    firebase.deleteFirebaseMemberAccount.mockReset();
    firebase.deleteFirebaseMemberAccount.mockResolvedValue(undefined);
    process.env.NODE_ENV = "test";
    delete process.env.TURNSTILE_SECRET_KEY;
  });

  it("leaves the application as a resumable DRAFT when Firebase create fails", async () => {
    const { submitDraft } = await import("./edge-service");
    const token = "resume-token-plain";
    db.state.application = draftApplication(await hashResumeToken(token));
    firebase.createFirebaseMemberAccount.mockRejectedValue(new Error("Firebase Admin is not configured; cannot create a login on submit."));

    const out = await submitDraft("app-1", token, { ip: "1.1.1.1" });

    expect(out.ok).toBe(false);
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ message: expect.stringMatching(/Firebase/i) });
    expect(db.state.insertedParticipants).toBe(0);
    expect(db.state.submitted).toBe(0);
    expect(db.state.application?.status).toBe("DRAFT");
    expect(db.state.application?.participantId).toBeNull();
    expect(firebase.deleteFirebaseMemberAccount).not.toHaveBeenCalled();
  });

  it("rolls back a new participant, SUBMITTED status, and Auth user when persist fails", async () => {
    const { submitDraft } = await import("./edge-service");
    const token = "resume-token-plain";
    db.state.application = draftApplication(await hashResumeToken(token));
    db.state.persistFailAt = "application";
    firebase.createFirebaseMemberAccount.mockResolvedValue({
      uid: "fb-uid-1",
      created: true,
      passwordEmailSent: true,
    });

    const out = await submitDraft("app-1", token, { ip: "1.1.1.1" });

    expect(out.ok).toBe(false);
    expect(out.status).toBe(400);
    expect(db.state.insertedParticipants).toBe(0);
    expect(db.state.deletedParticipants).toBe(1);
    expect(db.state.submitted).toBe(0);
    expect(db.state.revertedToDraft).toBe(1);
    expect(db.state.application?.status).toBe("DRAFT");
    expect(firebase.deleteFirebaseMemberAccount).toHaveBeenCalledWith("fb-uid-1");
  });

  it("writes firebaseUid in the same persist as member ID on success", async () => {
    const { submitDraft } = await import("./edge-service");
    const token = "resume-token-plain";
    db.state.application = draftApplication(await hashResumeToken(token));
    firebase.createFirebaseMemberAccount.mockResolvedValue({
      uid: "fb-uid-ok",
      created: true,
      passwordEmailSent: true,
    });

    const out = await submitDraft("app-1", token, { ip: "1.1.1.1" });

    expect(out.ok).toBe(true);
    expect(out.status).toBe(200);
    if (out.ok) {
      expect(out.body.memberIdNo).toMatch(/^B2C-JC-90-/);
      expect(out.body.passwordEmailSent).toBe(true);
    }
    expect(db.state.insertedParticipants).toBe(1);
    expect(db.state.submitted).toBe(1);
    const insert = db.state.queries.find((q) => /INSERT INTO "Participant"/.test(q.text));
    expect(insert?.values).toContain("fb-uid-ok");
    expect(firebase.deleteFirebaseMemberAccount).not.toHaveBeenCalled();
  });
});
