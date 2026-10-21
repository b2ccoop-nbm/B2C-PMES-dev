import { UnauthorizedException } from "@nestjs/common";
import { MembershipController } from "./membership.controller";

describe("MembershipController cron", () => {
  const prev = process.env.MEMBERSHIP_CRON_SECRET;

  afterEach(() => {
    process.env.MEMBERSHIP_CRON_SECRET = prev;
  });

  it("returns 401 when MEMBERSHIP_CRON_SECRET is unset", async () => {
    process.env.MEMBERSHIP_CRON_SECRET = "";
    const membership = { expireDrafts: jest.fn(), sendTreasurerReminders: jest.fn() };
    const controller = new MembershipController(membership as never);
    await expect(controller.cron("anything")).rejects.toBeInstanceOf(UnauthorizedException);
    expect(membership.expireDrafts).not.toHaveBeenCalled();
  });

  it("returns 401 when the secret is wrong", async () => {
    process.env.MEMBERSHIP_CRON_SECRET = "expected";
    const membership = { expireDrafts: jest.fn(), sendTreasurerReminders: jest.fn() };
    const controller = new MembershipController(membership as never);
    await expect(controller.cron("nope")).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("runs expire + reminders when the secret matches", async () => {
    process.env.MEMBERSHIP_CRON_SECRET = "expected";
    const membership = {
      expireDrafts: jest.fn().mockResolvedValue({ expired: 1, purged: 1 }),
      sendTreasurerReminders: jest.fn().mockResolvedValue({ reminded: 0 }),
    };
    const controller = new MembershipController(membership as never);
    const out = await controller.cron("expected");
    expect(out).toEqual({ ok: true, expired: { expired: 1, purged: 1 }, reminders: { reminded: 0 } });
  });
});
