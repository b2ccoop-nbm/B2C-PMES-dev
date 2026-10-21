import { edgeCorsOptions } from "@/lib/edge-cors";
import { getDraft, patchDraft } from "@/lib/membership/edge-service";
import { membershipError, membershipJson } from "@/lib/membership/http";
import { resumeTokenFromRequest } from "@/lib/membership/tokens";

export function OPTIONS() {
  return edgeCorsOptions();
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(request.url);
  const token = resumeTokenFromRequest(request, url.searchParams.get("t"));
  if (!token) return membershipError("Resume token is required.", 401);
  return membershipJson(await getDraft(id, token));
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const token = resumeTokenFromRequest(request, typeof body.resumeToken === "string" ? body.resumeToken : null);
  if (!token) return membershipError("Resume token is required.", 401);
  return membershipJson(await patchDraft(id, token, body));
}
