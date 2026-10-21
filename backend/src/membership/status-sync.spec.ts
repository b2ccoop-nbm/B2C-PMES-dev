import { derivedApplicationStatus, nextStatusAfterLifecycle } from "./status-sync";

describe("application status sync", () => {
  it("derives payment / BOD / approved from participant timestamps", () => {
    expect(derivedApplicationStatus({})).toBeNull();
    expect(derivedApplicationStatus({ initialFeesPaidAt: new Date() })).toBe("PAYMENT_CONFIRMED");
    expect(derivedApplicationStatus({ initialFeesPaidAt: new Date(), bodMajorityReachedAt: new Date() })).toBe("BOD_APPROVED");
    expect(
      derivedApplicationStatus({
        initialFeesPaidAt: new Date(),
        bodMajorityReachedAt: new Date(),
        boardApprovedAt: new Date(),
      }),
    ).toBe("APPROVED");
  });

  it("never overwrites reject / withdraw / expire", () => {
    expect(nextStatusAfterLifecycle("REJECTED", "APPROVED")).toBe("REJECTED");
    expect(nextStatusAfterLifecycle("SUBMITTED", "PAYMENT_CONFIRMED")).toBe("PAYMENT_CONFIRMED");
  });
});
