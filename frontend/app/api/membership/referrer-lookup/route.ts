import { edgeCorsOptions } from "@/lib/edge-cors";
import { lookupReferrer } from "@/lib/membership/edge-service";
import { membershipJson } from "@/lib/membership/http";
import { clientIpFromHeaders } from "@/lib/membership/tokens";

export function OPTIONS(request: Request) {
  return edgeCorsOptions(request);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  return membershipJson(
    await lookupReferrer(q, clientIpFromHeaders(request.headers), {
      email: url.searchParams.get("email"),
      mobile: url.searchParams.get("mobile"),
    }),
    request,
  );
}
