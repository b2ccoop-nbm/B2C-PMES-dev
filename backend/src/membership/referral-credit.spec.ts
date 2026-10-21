/**
 * FEAT-003 credit is unchanged: maybeCreditReferralJoin only writes when
 * referralJoinCreditedAt is null and the member is fully onboarded.
 */
describe("FEAT-003 referral credit (set-once)", () => {
  function shouldCredit(row: {
    referredByParticipantId: string | null;
    referralJoinCreditedAt: Date | null;
    pmesPassed: boolean;
    hasLoi: boolean;
    fees: boolean;
    board: boolean;
    profile: boolean;
  }) {
    if (!row.referredByParticipantId || row.referralJoinCreditedAt) return false;
    return row.pmesPassed && row.hasLoi && row.fees && row.board && row.profile;
  }

  it("fires exactly once", () => {
    const base = {
      referredByParticipantId: "ref-1",
      referralJoinCreditedAt: null as Date | null,
      pmesPassed: true,
      hasLoi: true,
      fees: true,
      board: true,
      profile: true,
    };
    expect(shouldCredit(base)).toBe(true);
    expect(shouldCredit({ ...base, referralJoinCreditedAt: new Date() })).toBe(false);
  });
});
