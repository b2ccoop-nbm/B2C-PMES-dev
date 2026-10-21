import { authorizeCronSecret } from "./cron-auth";

describe("authorizeCronSecret", () => {
  it("fails closed when the secret is unset", () => {
    expect(authorizeCronSecret("", "anything")).toEqual({ ok: false, status: 401, message: "Unauthorized" });
    expect(authorizeCronSecret(undefined, undefined)).toEqual({ ok: false, status: 401, message: "Unauthorized" });
  });

  it("rejects a wrong secret", () => {
    expect(authorizeCronSecret("correct", "wrong")).toEqual({ ok: false, status: 401, message: "Unauthorized" });
  });

  it("accepts a matching configured secret", () => {
    expect(authorizeCronSecret("correct", "correct")).toEqual({ ok: true });
  });
});
