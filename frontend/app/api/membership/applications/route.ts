import { edgeCorsOptions } from "@/lib/edge-cors";
import { createDraft } from "@/lib/membership/edge-service";
import { membershipJson } from "@/lib/membership/http";
import { clientIpFromHeaders, resumeCookie } from "@/lib/membership/tokens";
import { NextResponse } from "next/server";

export function OPTIONS() {
  return edgeCorsOptions();
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    mobile?: string;
    dpaConsent?: boolean;
    captchaToken?: string;
    referralCode?: string;
  };
  const result = await createDraft({
    email: String(body.email ?? ""),
    mobile: body.mobile,
    dpaConsent: body.dpaConsent === true,
    captchaToken: body.captchaToken,
    referralCode: body.referralCode,
    ip: clientIpFromHeaders(request.headers),
    userAgent: request.headers.get("user-agent") ?? "",
  });
  const res = membershipJson(result);
  if (result.ok && result.body && typeof result.body === "object" && "resumeToken" in result.body) {
    res.headers.append("Set-Cookie", resumeCookie(String((result.body as { resumeToken: string }).resumeToken)));
  }
  return res;
}

export function GET() {
  return NextResponse.json({ message: "Use POST to start an application" }, { status: 405 });
}
