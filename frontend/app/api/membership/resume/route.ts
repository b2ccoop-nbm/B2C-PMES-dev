import { edgeCorsOptions } from "@/lib/edge-cors";
import { claimResume } from "@/lib/membership/edge-service";
import { membershipError, membershipJson } from "@/lib/membership/http";
import { resumeCookie, resumeTokenFromRequest } from "@/lib/membership/tokens";

export function OPTIONS(request: Request) {
  return edgeCorsOptions(request);
}

export async function GET() {
  return membershipError("Use POST /membership/resume with the continue token. Tokens are not accepted in the URL.", 405);
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { token?: string; resumeToken?: string };
  const token = resumeTokenFromRequest(request, body.token || body.resumeToken);
  const result = await claimResume(token);
  const res = membershipJson(result, request);
  if (result.ok && result.body && typeof result.body === "object" && "resumeToken" in result.body) {
    res.headers.append("Set-Cookie", resumeCookie(String((result.body as { resumeToken: string }).resumeToken)));
  }
  return res;
}
