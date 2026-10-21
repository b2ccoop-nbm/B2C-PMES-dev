import { NextResponse } from "next/server";
import { edgeCorsHeaders } from "@/lib/edge-cors";

export function membershipJson(result: { ok: boolean; status: number; body: unknown }, request?: Request) {
  return NextResponse.json(result.body, { status: result.status, headers: edgeCorsHeaders(request?.headers.get("origin")) });
}

export function membershipError(message: string, status: number, request?: Request) {
  return NextResponse.json({ message, statusCode: status }, { status, headers: edgeCorsHeaders(request?.headers.get("origin")) });
}
