import { turnstileCanSkip, verifyTurnstile } from "./turnstile";

describe("Turnstile fail-closed", () => {
  const prev = { ...process.env };

  afterEach(() => {
    process.env.TURNSTILE_SECRET_KEY = prev.TURNSTILE_SECRET_KEY;
    process.env.TURNSTILE_TEST_BYPASS = prev.TURNSTILE_TEST_BYPASS;
    process.env.NODE_ENV = prev.NODE_ENV;
  });

  it("skips only in test / explicit bypass", () => {
    expect(turnstileCanSkip({ NODE_ENV: "test" })).toBe(true);
    expect(turnstileCanSkip({ NODE_ENV: "production" })).toBe(false);
    expect(turnstileCanSkip({ NODE_ENV: "production", TURNSTILE_TEST_BYPASS: "1" })).toBe(true);
  });

  it("rejects when the secret is unset outside tests", async () => {
    process.env.TURNSTILE_SECRET_KEY = "";
    process.env.TURNSTILE_TEST_BYPASS = "";
    process.env.NODE_ENV = "production";
    const out = await verifyTurnstile("token");
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/not configured/i);
  });
});
