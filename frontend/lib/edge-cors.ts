import { NextResponse } from "next/server";

/** Shared CORS for Edge API routes (b2ccoop.com → workers.dev). */
export const EDGE_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-member-sync-secret, X-Resume-Token, x-cron-secret",
};

export function edgeCorsOptions(): NextResponse {
  return new NextResponse(null, { status: 204, headers: EDGE_CORS_HEADERS });
}
