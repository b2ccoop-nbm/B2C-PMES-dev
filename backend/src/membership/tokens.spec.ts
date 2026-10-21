import {
  continueUrl,
  generateResumeToken,
  hashResumeToken,
  isResumeTokenExpired,
  resumeCookie,
  resumeTokenExpiresAt,
  tokensMatch,
} from "./tokens";

describe("resume tokens", () => {
  it("hashes tokens and compares them in constant time", () => {
    const token = generateResumeToken();
    const hash = hashResumeToken(token);
    expect(hash).toHaveLength(64);
    expect(tokensMatch(token, hash)).toBe(true);
    expect(tokensMatch("other", hash)).toBe(false);
  });

  it("expires after 30 days and keeps the claim out of the query string", () => {
    const now = new Date("2026-10-21T00:00:00.000Z");
    expect(isResumeTokenExpired(resumeTokenExpiresAt(now), now)).toBe(false);
    expect(isResumeTokenExpired(now, now)).toBe(true);
    expect(isResumeTokenExpired(null, now)).toBe(true);
    expect(continueUrl("https://b2ccoop.com", "abc")).toBe("https://b2ccoop.com/register/continue#c=abc");
    expect(resumeCookie("tok", { secure: true })).toMatch(/HttpOnly/);
    expect(resumeCookie("tok", { secure: true })).toMatch(/Secure/);
    expect(resumeCookie("tok", { secure: true })).not.toMatch(/localStorage/);
  });
});
