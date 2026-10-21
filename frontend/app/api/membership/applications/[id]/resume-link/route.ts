import { edgeCorsOptions } from "@/lib/edge-cors";
import { resendResume } from "@/lib/membership/edge-service";
import { membershipError, membershipJson } from "@/lib/membership/http";
import { resumeTokenFromRequest } from "@/lib/membership/tokens";

export function OPTIONS(request: Request) {
  return edgeCorsOptions(request);
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as { resumeToken?: string };
  const token = resumeTokenFromRequest(request, body.resumeToken);
  if (!token) return membershipError("Resume token is required.", 401, request);
  const result = await resendResume(id, token);
  return membershipJson(result, request);
}
