import { blockingFinding, evaluateDuplicates, type DuplicateLookup, type ExistingParticipantLite } from "./duplicate-engine";

function approved(partial: Partial<ExistingParticipantLite> = {}): ExistingParticipantLite {
  return {
    id: "p1",
    email: "a@test.com",
    phone: "+639171234567",
    tinNo: "123456789",
    fullName: "Ada Lovelace",
    dob: "1990-01-01",
    boardApprovedAt: new Date("2024-01-01"),
    legacyPioneerImport: false,
    ...partial,
  };
}

function emptyLookup(overrides: Partial<DuplicateLookup> = {}): DuplicateLookup {
  return {
    findParticipantByEmail: async () => null,
    findParticipantByMobile: async () => null,
    findParticipantByTin: async () => null,
    findParticipantByNameDob: async () => null,
    findOpenApplicationByEmail: async () => null,
    firebaseEmailExists: async () => false,
    ...overrides,
  };
}

describe("duplicate engine", () => {
  it("blocks an existing email", async () => {
    const findings = await evaluateDuplicates(
      { email: "A@test.com" },
      emptyLookup({ findParticipantByEmail: async () => approved() }),
    );
    expect(blockingFinding(findings)?.kind).toBe("email");
  });

  it("blocks an approved member mobile and flags a pending one", async () => {
    const blocked = await evaluateDuplicates(
      { email: "new@test.com", mobile: "09171234567" },
      emptyLookup({ findParticipantByMobile: async () => approved() }),
    );
    expect(blockingFinding(blocked)?.kind).toBe("mobile");

    const flagged = await evaluateDuplicates(
      { email: "new@test.com", mobile: "09171234567" },
      emptyLookup({ findParticipantByMobile: async () => approved({ boardApprovedAt: null }) }),
    );
    expect(blockingFinding(flagged)).toBeUndefined();
    expect(flagged.some((f) => f.action === "flag")).toBe(true);
  });

  it("blocks TIN and routes legacy TIN to reclaim", async () => {
    const block = await evaluateDuplicates(
      { email: "new@test.com", tinNo: "123456789" },
      emptyLookup({ findParticipantByTin: async () => approved() }),
    );
    expect(blockingFinding(block)?.kind).toBe("tin");

    const reclaim = await evaluateDuplicates(
      { email: "new@test.com", tinNo: "123456789" },
      emptyLookup({ findParticipantByTin: async () => approved({ legacyPioneerImport: true }) }),
    );
    expect(blockingFinding(reclaim)?.action).toBe("reclaim");
  });

  it("flags name+DOB matches", async () => {
    const findings = await evaluateDuplicates(
      { email: "new@test.com", fullName: "Ada Lovelace", dob: "1990-01-01" },
      emptyLookup({ findParticipantByNameDob: async () => approved({ boardApprovedAt: null }) }),
    );
    expect(findings.some((f) => f.kind === "name_dob" && f.action === "flag")).toBe(true);
  });
});
