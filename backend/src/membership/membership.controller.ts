import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { StaffJwtGuard, type StaffJwtPayload } from "../auth/staff-jwt.guard";
import { CreateMembershipApplicationDto } from "./dto/create-application.dto";
import { MembershipService } from "./membership.service";
import { clientIpFromRequest } from "./tokens";

type StaffRequest = Request & { staffUser: StaffJwtPayload };

function resumeTokenFrom(req: Request, headerToken?: string, bodyToken?: string): string {
  return String(headerToken || bodyToken || (req as Request & { cookies?: Record<string, string> }).cookies?.b2c_membership_resume || "").trim();
}

@Controller()
export class MembershipController {
  constructor(private readonly membership: MembershipService) {}

  @Post("membership/applications")
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  create(@Body() dto: CreateMembershipApplicationDto, @Req() req: Request) {
    return this.membership.createDraft({
      email: dto.email,
      mobile: dto.mobile,
      dpaConsent: dto.dpaConsent,
      captchaToken: dto.captchaToken,
      referralCode: dto.referralCode,
      ip: clientIpFromRequest(req.headers as Record<string, string | string[] | undefined>),
      userAgent: String(req.headers["user-agent"] ?? ""),
    });
  }

  @Get("membership/applications/:id")
  getOne(
    @Param("id") id: string,
    @Headers("x-resume-token") headerToken: string | undefined,
    @Query("t") queryToken: string | undefined,
    @Req() req: Request,
  ) {
    return this.membership.getDraft(id, resumeTokenFrom(req, headerToken, queryToken));
  }

  @Patch("membership/applications/:id")
  patch(
    @Param("id") id: string,
    @Headers("x-resume-token") headerToken: string | undefined,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
  ) {
    const token = resumeTokenFrom(req, headerToken, typeof body.resumeToken === "string" ? body.resumeToken : undefined);
    return this.membership.patchDraft(id, token, body);
  }

  @Post("membership/applications/:id/submit")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  submit(
    @Param("id") id: string,
    @Headers("x-resume-token") headerToken: string | undefined,
    @Body() body: { resumeToken?: string; captchaToken?: string },
    @Req() req: Request,
  ) {
    return this.membership.submit(id, resumeTokenFrom(req, headerToken, body.resumeToken), {
      captchaToken: body.captchaToken,
      ip: clientIpFromRequest(req.headers as Record<string, string | string[] | undefined>),
    });
  }

  @Post("membership/applications/:id/resume-link")
  resumeLink(
    @Param("id") id: string,
    @Headers("x-resume-token") headerToken: string | undefined,
    @Body() body: { resumeToken?: string },
    @Req() req: Request,
  ) {
    return this.membership.resendResumeLink(id, resumeTokenFrom(req, headerToken, body.resumeToken));
  }

  @Post("membership/applications/:id/gcash-screenshot")
  screenshot(
    @Param("id") id: string,
    @Headers("x-resume-token") headerToken: string | undefined,
    @Body() body: { resumeToken?: string; objectKey?: string },
    @Req() req: Request,
  ) {
    const key = String(body.objectKey ?? "").trim();
    return this.membership.attachScreenshot(id, resumeTokenFrom(req, headerToken, body.resumeToken), key || `mock:${id}`);
  }

  @Get("membership/referrer-lookup")
  @Throttle({ default: { limit: 40, ttl: 60000 } })
  lookup(@Query("q") q: string, @Req() req: Request) {
    return this.membership.lookupReferrer(
      q,
      clientIpFromRequest(req.headers as Record<string, string | string[] | undefined>),
    );
  }

  @Post("membership/cron")
  async cron(@Headers("x-cron-secret") secret: string | undefined) {
    const expected = String(process.env.MEMBERSHIP_CRON_SECRET ?? "").trim();
    if (expected && secret !== expected) {
      return { ok: false };
    }
    const expired = await this.membership.expireDrafts();
    const reminders = await this.membership.sendTreasurerReminders();
    return { ok: true, expired, reminders };
  }

  @Get("pmes/admin/membership-applications")
  @UseGuards(StaffJwtGuard)
  adminList(@Query("status") status?: string, @Query("q") q?: string) {
    return this.membership.adminList({ status, q });
  }

  @Post("pmes/admin/membership-applications/:id/confirm-payment")
  @UseGuards(StaffJwtGuard)
  confirmPayment(@Param("id") id: string, @Req() req: StaffRequest, @Body() body: { receiptNo?: string }) {
    return this.membership.adminConfirmPayment(id, req.staffUser, body);
  }

  @Post("pmes/admin/membership-applications/:id/reject")
  @UseGuards(StaffJwtGuard)
  reject(@Param("id") id: string, @Req() req: StaffRequest, @Body() body: { reason?: string }) {
    return this.membership.adminReject(id, req.staffUser, String(body.reason ?? ""));
  }

  @Patch("pmes/admin/membership-applications/:id/referrer")
  @UseGuards(StaffJwtGuard)
  patchReferrer(@Param("id") id: string, @Req() req: StaffRequest, @Body() body: { referredByParticipantId?: string | null }) {
    return this.membership.adminPatchReferrer(id, req.staffUser, body.referredByParticipantId ?? null);
  }
}
