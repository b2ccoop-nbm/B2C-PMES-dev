import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { MembershipApplicationStatus } from "@prisma/client";
import { MembershipService } from "./membership.service";
import { hashResumeToken } from "./tokens";

function decimal(n: number) {
  return { toString: () => String(n), valueOf: () => n } as unknown as { toNumber?: () => number };
}

function draftRow(overrides: Record<string, unknown> = {}) {
  const token = "resume-token-plain";
  return {
    id: "app-1",
    status: MembershipApplicationStatus.DRAFT,
    resumeTokenHash: hashResumeToken(token),
    participantId: null,
    fullName: "Juan Dela Cruz",
    firstName: "Juan",
    middleName: null,
    lastName: "Cruz",
    dob: new Date("1990-01-15"),
    gender: "male",
    email: "juan@example.com",
    mobile: "+639171234567",
    tinNo: "123456789",
    residentialAddress: { street: "1 Mabini", barangay: "Lahug", cityMunicipality: "Cebu City", province: "Cebu", zip: "6000" },
    referredByParticipantId: null,
    shareCapitalAmount: 1000,
    shareCapitalPaid: false,
    membershipFeeAmount: 500,
    membershipFeePaid: false,
    paymentMode: null,
    gcashRefNo: null,
    gcashScreenshotKey: null,
    paymentDeclaredAt: null,
    treasurerNotifiedAt: null,
    dpaConsentAt: new Date(),
    dpaConsentVersion: "2026-10-21",
    consentIp: "1.1.1.1",
    userAgent: "test",
    possibleDuplicateOfId: null,
    submittedAt: null,
    paymentConfirmedAt: null,
    paymentConfirmedById: null,
    receiptNo: null,
    rejectedAt: null,
    rejectionReason: null,
    resumeTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    pendingResumeTokenHash: null,
    pendingResumeTokenExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function prismaMock(row: ReturnType<typeof draftRow>, extras: Record<string, unknown> = {}): Record<string, any> {
  const rate = { count: 1 };
  return {
    membershipRateLimit: {
      upsert: jest.fn().mockResolvedValue(rate),
    },
    membershipApplication: {
      findUnique: jest.fn().mockResolvedValue(row),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data })),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(1),
    },
    participant: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "p-new",
        ...data,
      })),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "p-new",
        email: row.email,
        fullName: row.fullName,
        ...data,
      })),
    },
    staffUser: {
      findMany: jest.fn().mockResolvedValue([{ email: "treasurer@b2ccoop.com" }]),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaMock(row))),
    $queryRaw: jest.fn().mockResolvedValue([]),
    ...extras,
  };
}

function firebasePort() {
  return {
    lookupByEmail: jest.fn().mockResolvedValue(null),
    signUp: jest.fn().mockResolvedValue({ localId: "fb-uid-1", email: "juan@example.com" }),
    sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
    deleteUser: jest.fn().mockResolvedValue(undefined),
  };
}

function serviceFor(row: ReturnType<typeof draftRow>, extras: Record<string, unknown> = {}) {
  const prisma = prismaMock(row, extras);
  const accounting = { postInitialFeesPaidAwait: jest.fn().mockResolvedValue({ ok: true, created: true }) };
  const firebase = firebasePort();
  const service = new MembershipService(prisma as never, accounting as never, firebase);
  return { service, prisma, accounting, firebase };
}

describe("MembershipService", () => {
  it("does not rotate a token or return PII when the email already has an application", async () => {
    const open = draftRow();
    const priorHash = open.resumeTokenHash;
    const { service, prisma } = serviceFor(open);
    prisma.membershipApplication.findFirst.mockResolvedValueOnce(open);
    const out = await service.createDraft({
      email: "juan@example.com",
      dpaConsent: true,
      ip: "1.1.1.1",
    });
    expect(out.checkEmail).toBe(true);
    expect(out.message).toMatch(/already in progress/i);
    expect(out.message).not.toMatch(/check your email|emailed/i);
    expect(out).not.toHaveProperty("resumeToken");
    expect(out).not.toHaveProperty("continueUrl");
    expect(out).not.toHaveProperty("tinNo");
    expect(prisma.membershipApplication.update).not.toHaveBeenCalled();
    expect(priorHash).toBe(open.resumeTokenHash);
  });

  it("does not treat a submitted application as publicly resumable", async () => {
    const open = draftRow({ status: MembershipApplicationStatus.SUBMITTED });
    const { service, prisma } = serviceFor(open);
    prisma.membershipApplication.findFirst.mockResolvedValueOnce(open);
    const out = await service.createDraft({
      email: "juan@example.com",
      dpaConsent: true,
      ip: "1.1.1.1",
    });
    expect(out.checkEmail).toBe(true);
    expect(prisma.membershipApplication.update).not.toHaveBeenCalled();
  });

  it("allows submit before paying (cash unpaid)", async () => {
    const row = draftRow({ shareCapitalPaid: false, membershipFeePaid: false, paymentMode: null });
    const { service } = serviceFor(row);
    const out = await service.submit(row.id, "resume-token-plain", { ip: "1.1.1.1" });
    expect(out.memberIdNo).toMatch(/^B2C-JC-90-/);
    expect(out.application.status).toBe(MembershipApplicationStatus.SUBMITTED);
  });

  it("submits a GCash path with and without screenshot", async () => {
    const row = draftRow({
      shareCapitalPaid: true,
      membershipFeePaid: true,
      paymentMode: "GCASH",
      gcashRefNo: "1234567890123",
      gcashScreenshotKey: null,
    });
    const { service } = serviceFor(row);
    const out = await service.submit(row.id, "resume-token-plain", { ip: "1.1.1.1" });
    expect(out.application.paymentMode).toBe("GCASH");
    expect(out.application.hasGcashScreenshot).toBe(false);

    const withShot = draftRow({
      shareCapitalPaid: true,
      membershipFeePaid: true,
      paymentMode: "GCASH",
      gcashRefNo: "1234567890123",
      gcashScreenshotKey: "r2/key.png",
    });
    const again = serviceFor(withShot);
    const out2 = await again.service.submit(withShot.id, "resume-token-plain", { ip: "1.1.1.1" });
    expect(out2.application.hasGcashScreenshot).toBe(true);
  });

  it("rejects under-18 and a non-approved referrer", async () => {
    const young = draftRow({ dob: new Date("2015-01-01") });
    const a = serviceFor(young);
    await expect(a.service.submit(young.id, "resume-token-plain", { ip: "1.1.1.1" })).rejects.toBeInstanceOf(BadRequestException);

    const referred = draftRow({ referredByParticipantId: "ref-1" });
    const b = serviceFor(referred);
    b.prisma.participant.findFirst.mockResolvedValue(null);
    await expect(b.service.submit(referred.id, "resume-token-plain", { ip: "1.1.1.1" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("blocks duplicate email at submit", async () => {
    const row = draftRow();
    const { service, prisma } = serviceFor(row);
    prisma.participant.findUnique.mockImplementation(async ({ where }: { where: { email?: string } }) => {
      if (where.email) {
        return {
          id: "existing",
          email: row.email,
          phone: row.mobile,
          tinNo: "999",
          fullName: "Other",
          dob: "1980-01-01",
          boardApprovedAt: new Date(),
          legacyPioneerImport: false,
          firebaseUid: "other-uid",
        };
      }
      return null;
    });
    await expect(service.submit(row.id, "resume-token-plain", { ip: "1.1.1.1" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("stamps an in-app treasurer notice on confirm-needed submit", async () => {
    const row = draftRow({ shareCapitalPaid: true, membershipFeePaid: true, paymentMode: "CASH" });
    const { service, prisma, firebase } = serviceFor(row);
    const out = await service.submit(row.id, "resume-token-plain", { ip: "1.1.1.1" });
    expect(out.passwordEmailSent).toBe(true);
    expect(firebase.sendPasswordResetEmail).toHaveBeenCalledWith(row.email);
    expect(prisma.staffUser.findMany).not.toHaveBeenCalled();
    const stamp = prisma.membershipApplication.update.mock.calls.find(
      (c: [{ data?: { treasurerNotifiedAt?: Date } }]) => c[0]?.data?.treasurerNotifiedAt,
    );
    expect(stamp?.[0].data.treasurerNotifiedAt).toBeInstanceOf(Date);
  });

  it("returns the live continue URL to an authorized resend caller", async () => {
    const row = draftRow();
    const { service, prisma } = serviceFor(row);
    const out = await service.resendResumeLink(row.id, "resume-token-plain");
    expect(out.continueUrl).toMatch(/\/register\/continue#c=resume-token-plain/);
    expect(prisma.membershipApplication.update).not.toHaveBeenCalled();
  });

  it("returns an on-screen continue URL for a new draft", async () => {
    const { service, prisma } = serviceFor(draftRow());
    prisma.membershipApplication.findFirst.mockResolvedValueOnce(null);
    const out = await service.createDraft({
      email: "fresh@example.com",
      dpaConsent: true,
      ip: "2.2.2.2",
    });
    expect("continueUrl" in out && out.continueUrl).toMatch(/\/register\/continue#c=/);
    expect("resumeToken" in out && out.resumeToken).toBeTruthy();
  });

  it("expires drafts older than 60 days and purges by createdAt in the same run", async () => {
    const { service, prisma } = serviceFor(draftRow());
    const out = await service.expireDrafts();
    expect(out.expired).toBe(1);
    expect(prisma.membershipApplication.updateMany).toHaveBeenCalled();
    const findMany = prisma.membershipApplication.findMany.mock.calls.find((c: [{ where?: { createdAt?: unknown; updatedAt?: unknown } }]) =>
      c[0]?.where && "createdAt" in (c[0].where as object),
    );
    expect(findMany?.[0].where.createdAt).toBeTruthy();
    expect(findMany?.[0].where.updatedAt).toBeUndefined();
  });

  it("rejects an expired resume token", async () => {
    const row = draftRow({ resumeTokenExpiresAt: new Date(Date.now() - 1000) });
    const { service } = serviceFor(row);
    await expect(service.getDraft(row.id, "resume-token-plain")).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("stores a server-generated screenshot key after magic-byte checks", async () => {
    const row = draftRow();
    const { service, prisma } = serviceFor(row);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    const out = await service.attachScreenshot(row.id, "resume-token-plain", jpeg);
    expect(out.hasGcashScreenshot).toBe(true);
    const key = prisma.membershipApplication.update.mock.calls[0][0].data.gcashScreenshotKey as string;
    expect(key).toMatch(/^mock:membership\/app-1\//);
  });

  it("rejects a self or same-email referrer", async () => {
    const row = draftRow({ email: "juan@example.com" });
    const { service, prisma } = serviceFor(row);
    prisma.participant.findFirst.mockResolvedValue({
      id: "ref-self",
      email: "juan@example.com",
      phone: "+639171234567",
      boardApprovedAt: new Date(),
    });
    await expect(
      service.patchDraft(row.id, "resume-token-plain", { referredByParticipantId: "ref-self" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("creates Firebase after the participant write and compensates on link failure", async () => {
    const row = draftRow();
    const { service, prisma, firebase } = serviceFor(row);
    const order: string[] = [];
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      order.push("db");
      return fn(prisma);
    });
    firebase.signUp.mockImplementation(async () => {
      order.push("firebase");
      return { localId: "fb-uid-1", email: row.email };
    });
    prisma.participant.update.mockImplementation(async () => {
      order.push("link");
      throw new Error("link failed");
    });
    await expect(service.submit(row.id, "resume-token-plain", { ip: "1.1.1.1" })).rejects.toThrow(/link failed/);
    expect(order[0]).toBe("db");
    expect(order).toContain("firebase");
    expect(firebase.deleteUser).toHaveBeenCalledWith("fb-uid-1");
  });

  it("rate-limits extra drafts from one IP", async () => {
    const { service, prisma } = serviceFor(draftRow());
    prisma.membershipRateLimit.upsert.mockResolvedValue({ count: 6 });
    await expect(
      service.createDraft({ email: "b@test.com", dpaConsent: true, ip: "9.9.9.9" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects an application and confirms payment through the treasurer path", async () => {
    const row = draftRow({
      status: MembershipApplicationStatus.SUBMITTED,
      participantId: "p-1",
    });
    const { service, prisma, accounting } = serviceFor(row);
    prisma.participant.findUnique.mockResolvedValue({
      id: "p-1",
      email: row.email,
      fullName: row.fullName,
      memberIdNo: "B2C-JC-90-ABCD",
      initialFeesPaidAt: null,
    });
    const rejected = await service.adminReject(row.id, { sub: "sec-1", role: "secretary" }, "incomplete documents");
    expect(rejected.status).toBe(MembershipApplicationStatus.REJECTED);

    const confirmed = await service.adminConfirmPayment(row.id, { sub: "tr-1", role: "treasurer" }, { receiptNo: "OR-1" });
    expect(confirmed.application.status).toBe(MembershipApplicationStatus.PAYMENT_CONFIRMED);
    expect(accounting.postInitialFeesPaidAwait).toHaveBeenCalled();
  });

  it("omits possibleDuplicateOfId from public payloads", async () => {
    const row = draftRow({ possibleDuplicateOfId: "other-member-id" });
    const { service } = serviceFor(row);
    const out = await service.getDraft(row.id, "resume-token-plain");
    expect(out).not.toHaveProperty("possibleDuplicateOfId");
    expect(out).not.toHaveProperty("gcashScreenshotKey");
  });

  it("restricts the admin list and never returns a raw screenshot key", async () => {
    const row = draftRow({
      possibleDuplicateOfId: "other-id",
      gcashScreenshotKey: "membership/app-1/secret.webp",
    });
    const { service, prisma } = serviceFor(row);
    prisma.membershipApplication.findMany.mockResolvedValue([{ ...row, participant: { memberIdNo: "B2C-XX-90-AAAA" } }]);
    await expect(service.adminList({ role: "board_director" }, {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.adminList({ role: "admin" }, {})).rejects.toBeInstanceOf(ForbiddenException);
    const list = await service.adminList({ role: "treasurer" }, {});
    const app = list.applications[0];
    expect(app).not.toHaveProperty("gcashScreenshotKey");
    expect(app).not.toHaveProperty("possibleDuplicateOfId");
    expect(app.flaggedPossibleDuplicate).toBe(true);
    expect(app.screenshotUrl).toBe("/pmes/admin/membership-applications/app-1/screenshot");
    expect(JSON.stringify(app)).not.toContain("secret.webp");
    expect(list.inbox.paymentsToConfirm).toBe(1);
    expect(list.inbox.treasurerNotice).toBe(true);
  });

  it("serves screenshots only to treasurer/secretary/superuser and never leaks the key", async () => {
    const row = draftRow({ gcashScreenshotKey: "membership/app-1/secret.webp" });
    const { service, prisma } = serviceFor(row);
    prisma.membershipApplication.findUnique.mockResolvedValue({ gcashScreenshotKey: "membership/app-1/secret.webp" });
    await expect(service.adminGetScreenshot(row.id, { role: "board_director" })).rejects.toBeInstanceOf(ForbiddenException);
    try {
      await service.adminGetScreenshot(row.id, { role: "treasurer" });
      throw new Error("expected not found");
    } catch (e) {
      expect(e).toBeInstanceOf(NotFoundException);
      expect(String((e as Error).message)).toBe("Screenshot not available");
      expect(JSON.stringify(e)).not.toContain("secret.webp");
    }
  });
});

describe("decimal helper keeps tests typed", () => {
  it("exists", () => {
    expect(Number(decimal(1000).valueOf())).toBe(1000);
  });
});
