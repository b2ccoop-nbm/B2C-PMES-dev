import { edgeCorsOptions } from "@/lib/edge-cors";
import { lookupReferrer } from "@/lib/membership/edge-service";
import { membershipJson } from "@/lib/membership/http";
import { clientIpFromHeaders } from "@/lib/membership/tokens";

export function OPTIONS() {
  return edgeCorsOptions();
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return membershipJson(await lookupReferrer(q, clientIpFromHeaders(request.headers)));
}
