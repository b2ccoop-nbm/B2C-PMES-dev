import { edgeCorsOptions } from "@/lib/edge-cors";
import { runMembershipCron } from "@/lib/membership/edge-service";
import { membershipError } from "@/lib/membership/http";
import { NextResponse } from "next/server";
import { EDGE_CORS_HEADERS } from "@/lib/edge-cors";

export function OPTIONS() {
  return edgeCorsOptions();
}

export async function POST(request: Request) {
  const expected = String(process.env.MEMBERSHIP_CRON_SECRET ?? "").trim();
  const got = request.headers.get("x-cron-secret") ?? "";
  if (expected && got !== expected) return membershipError("Unauthorized", 401);
  const body = await runMembershipCron();
  return NextResponse.json({ ok: true, ...body }, { headers: EDGE_CORS_HEADERS });
}
