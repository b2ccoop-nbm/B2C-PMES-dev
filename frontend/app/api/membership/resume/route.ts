import { getSql } from "@/lib/db";
import { edgeCorsOptions } from "@/lib/edge-cors";
import { toPublicApplication, type ApplicationRow } from "@/lib/membership/edge-service";
import { membershipError } from "@/lib/membership/http";
import { hashResumeToken, resumeCookie } from "@/lib/membership/tokens";
import { NextResponse } from "next/server";
import { EDGE_CORS_HEADERS } from "@/lib/edge-cors";

export function OPTIONS() {
  return edgeCorsOptions();
}

export async function GET(request: Request) {
  const t = new URL(request.url).searchParams.get("t") ?? "";
  if (!t.trim()) return membershipError("Resume token is required.", 400);
  const hash = await hashResumeToken(t.trim());
  const sql = getSql();
  const rows = await sql`SELECT * FROM "MembershipApplication" WHERE "resumeTokenHash" = ${hash} LIMIT 1`;
  const row = (rows as ApplicationRow[])[0];
  if (!row) return membershipError("This continue link is invalid or expired.", 404);
  const res = NextResponse.json({ ...toPublicApplication(row), resumeToken: t.trim() }, { headers: EDGE_CORS_HEADERS });
  res.headers.append("Set-Cookie", resumeCookie(t.trim()));
  return res;
}
