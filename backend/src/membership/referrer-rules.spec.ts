import { referrerConflictMessage } from "./referrer-rules";

describe("D6 referrer self / same-contact", () => {
  it("rejects self and the same email or mobile", () => {
    expect(
      referrerConflictMessage({
        referrerId: "p1",
        applicantParticipantId: "p1",
        referrerEmail: "a@test.com",
        applicantEmail: "b@test.com",
      }),
    ).toMatch(/yourself/i);
    expect(
      referrerConflictMessage({
        referrerId: "p2",
        referrerEmail: "Same@Test.com",
        applicantEmail: "same@test.com",
      }),
    ).toMatch(/same email/i);
    expect(
      referrerConflictMessage({
        referrerId: "p3",
        referrerPhone: "09171234567",
        applicantMobile: "+639171234567",
      }),
    ).toMatch(/same mobile/i);
  });

  it("allows a distinct approved referrer", () => {
    expect(
      referrerConflictMessage({
        referrerId: "p4",
        referrerEmail: "ref@test.com",
        referrerPhone: "09170000000",
        applicantEmail: "app@test.com",
        applicantMobile: "09171111111",
      }),
    ).toBeNull();
  });
});
