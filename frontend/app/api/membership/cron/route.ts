import { edgeCorsHeaders, edgeCorsOptions } from "@/lib/edge-cors";
import { authorizeCronSecret } from "@/lib/membership/cron-auth";
import { runMembershipCron } from "@/lib/membership/edge-service";
import { membershipError } from "@/lib/membership/http";
import { NextResponse } from "next/server";

export function OPTIONS(request: Request) {
  return edgeCorsOptions(request);
}

export async function POST(request: Request) {
  const gate = authorizeCronSecret(process.env.MEMBERSHIP_CRON_SECRET, request.headers.get("x-cron-secret"));
  if (!gate.ok) return membershipError(gate.message, gate.status, request);
  const body = await runMembershipCron();
  return NextResponse.json({ ok: true, ...body }, { headers: edgeCorsHeaders(request.headers.get("origin")) });
}
