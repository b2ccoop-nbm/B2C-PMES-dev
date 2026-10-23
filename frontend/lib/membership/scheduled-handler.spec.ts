import { afterEach, describe, expect, it, vi } from "vitest";
import { runMembershipScheduled } from "./scheduled-handler.js";

describe("runMembershipScheduled", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips the cron POST when MEMBERSHIP_CRON_SECRET is unset", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = vi.fn();
    const waitUntil = vi.fn();

    await runMembershipScheduled({ fetch }, { cron: "0 16 * * *" }, {}, { waitUntil });

    expect(fetch).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "[membership-cron] MEMBERSHIP_CRON_SECRET is not set; skipping scheduled run",
    );
  });

  it("POSTs /api/membership/cron with X-Cron-Secret from env", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const pending: Promise<unknown>[] = [];
    const waitUntil = vi.fn((p: Promise<unknown>) => {
      pending.push(p);
    });

    await runMembershipScheduled(
      { fetch },
      { cron: "0 16 * * *" },
      { MEMBERSHIP_CRON_SECRET: "s3cret", CRON_INTERNAL_ORIGIN: "https://b2ccoop-webapp.internal/" },
      { waitUntil },
    );

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(pending);

    expect(fetch).toHaveBeenCalledTimes(1);
    const req = fetch.mock.calls[0]![0] as Request;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://b2ccoop-webapp.internal/api/membership/cron");
    expect(req.headers.get("X-Cron-Secret")).toBe("s3cret");
    expect(req.headers.get("Content-Type")).toBe("application/json");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/\[membership-cron\] 0 16 \* \* \* ok:/));
  });

  it("logs when the cron route returns a non-OK status", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const pending: Promise<unknown>[] = [];
    const waitUntil = vi.fn((p: Promise<unknown>) => {
      pending.push(p);
    });

    await runMembershipScheduled(
      { fetch },
      { cron: "0 16 * * *" },
      { MEMBERSHIP_CRON_SECRET: "s3cret" },
      { waitUntil },
    );
    await Promise.all(pending);

    expect(error).toHaveBeenCalledWith("[membership-cron] 0 16 * * * failed: 401 nope");
  });
});
