import { edgeCorsOptions } from "@/lib/edge-cors";
import { submitDraft } from "@/lib/membership/edge-service";
import { membershipError, membershipJson } from "@/lib/membership/http";
import { clientIpFromHeaders, resumeCookie, resumeTokenFromRequest } from "@/lib/membership/tokens";

export function OPTIONS() {
  return edgeCorsOptions();
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as { resumeToken?: string; captchaToken?: string };
  const token = resumeTokenFromRequest(request, body.resumeToken);
  if (!token) return membershipError("Resume token is required.", 401);
  const result = await submitDraft(id, token, {
    captchaToken: body.captchaToken,
    ip: clientIpFromHeaders(request.headers),
  });
  const res = membershipJson(result);
  if (result.ok && result.body && typeof result.body === "object" && "resumeToken" in result.body) {
    res.headers.append("Set-Cookie", resumeCookie(String((result.body as { resumeToken: string }).resumeToken)));
  }
  return res;
}
