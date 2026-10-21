import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { StaffJwtGuard, type StaffJwtPayload } from "../auth/staff-jwt.guard";
import { authorizeCronSecret } from "./cron-auth";
import { CreateMembershipApplicationDto } from "./dto/create-application.dto";
import { MembershipService } from "./membership.service";
import { clientIpFromRequest, resumeCookie, resumeTokenFromCookieHeader } from "./tokens";

type StaffRequest = Request & { staffUser: StaffJwtPayload };

function resumeTokenFrom(req: Request, headerToken?: string, bodyToken?: string): string {
  return String(
    headerToken ||
      bodyToken ||
      resumeTokenFromCookieHeader(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined),
  ).trim();
}

function maybeSetResumeCookie(res: Response, token?: string) {
  if (token) res.setHeader("Set-Cookie", resumeCookie(token));
}

@Controller()
export class MembershipController {
  constructor(private readonly membership: MembershipService) {}

  @Post("membership/applications")
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async create(
    @Body() dto: CreateMembershipApplicationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.membership.createDraft({
      email: dto.email,
      mobile: dto.mobile,
      dpaConsent: dto.dpaConsent,
      captchaToken: dto.captchaToken,
      referralCode: dto.referralCode,
      ip: clientIpFromRequest(req.headers as Record<string, string | string[] | undefined>),
      userAgent: String(req.headers["user-agent"] ?? ""),
    });
    if ("resumeToken" in out && typeof out.resumeToken === "string") {
      maybeSetResumeCookie(res, out.resumeToken);
    }
    return out;
  }

  @Post("membership/resume")
  async claim(
    @Body() body: { token?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = resumeTokenFrom(req, undefined, body.token);
    const out = await this.membership.claimResume(token);
    maybeSetResumeCookie(res, out.resumeToken);
    return out;
  }

  @Get("membership/applications/:id")
  getOne(
    @Param("id") id: string,
    @Headers("x-resume-token") headerToken: string | undefined,
    @Req() req: Request,
  ) {
    return this.membership.getDraft(id, resumeTokenFrom(req, headerToken));
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
  async submit(
    @Param("id") id: string,
    @Headers("x-resume-token") headerToken: string | undefined,
    @Body() body: { resumeToken?: string; captchaToken?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.membership.submit(id, resumeTokenFrom(req, headerToken, body.resumeToken), {
      captchaToken: body.captchaToken,
      ip: clientIpFromRequest(req.headers as Record<string, string | string[] | undefined>),
    });
    maybeSetResumeCookie(res, out.resumeToken);
    return out;
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
  @UseInterceptors(FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  screenshot(
    @Param("id") id: string,
    @Headers("x-resume-token") headerToken: string | undefined,
    @UploadedFile() file: { buffer?: Buffer } | undefined,
    @Body() body: { resumeToken?: string; objectKey?: string },
    @Req() req: Request,
  ) {
    if (body?.objectKey) {
      throw new BadRequestException("Client object keys are not accepted.");
    }
    if (!file?.buffer?.length) {
      throw new BadRequestException("Screenshot file is required.");
    }
    return this.membership.attachScreenshot(id, resumeTokenFrom(req, headerToken, body?.resumeToken), file.buffer);
  }

  @Get("membership/referrer-lookup")
  @Throttle({ default: { limit: 40, ttl: 60000 } })
  lookup(
    @Query("q") q: string,
    @Query("email") email: string | undefined,
    @Query("mobile") mobile: string | undefined,
    @Req() req: Request,
  ) {
    return this.membership.lookupReferrer(
      q,
      clientIpFromRequest(req.headers as Record<string, string | string[] | undefined>),
      { email, mobile },
    );
  }

  @Post("membership/cron")
  async cron(@Headers("x-cron-secret") secret: string | undefined) {
    const gate = authorizeCronSecret(process.env.MEMBERSHIP_CRON_SECRET, secret);
    if (!gate.ok) throw new UnauthorizedException(gate.message);
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
