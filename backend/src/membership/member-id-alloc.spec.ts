import { allocateMemberPublicId, maskGivenName, referrerIsApproved } from "./member-id-alloc";

describe("member ID allocation", () => {
  it("retries on collision and returns a unique id", async () => {
    const seen = new Set<string>();
    let calls = 0;
    const id = await allocateMemberPublicId({
      fullName: "Juan Dela Cruz",
      firstName: "Juan",
      lastName: "Cruz",
      dob: "1990-05-01",
      exists: async (candidate) => {
        calls += 1;
        if (seen.size < 2) {
          seen.add(candidate);
          return true;
        }
        return seen.has(candidate);
      },
    });
    expect(id.startsWith("B2C-JC-90-")).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("fails after the configured retry budget", async () => {
    await expect(
      allocateMemberPublicId({
        fullName: "A B",
        dob: "1991-01-01",
        maxAttempts: 5,
        exists: async () => true,
      }),
    ).rejects.toThrow(/5 retries/);
  });

  it("requires an approved referrer", () => {
    expect(referrerIsApproved({ boardApprovedAt: new Date() })).toBe(true);
    expect(referrerIsApproved({ boardApprovedAt: null })).toBe(false);
    expect(referrerIsApproved(null)).toBe(false);
  });

  it("masks given names for type-ahead", () => {
    expect(maskGivenName("Juan Dela Cruz")).toBe("Juan C.");
  });
});
