import { NextResponse } from "next/server";
import { EDGE_CORS_HEADERS } from "@/lib/edge-cors";

export function membershipJson(result: { ok: boolean; status: number; body: unknown }) {
  return NextResponse.json(result.body, { status: result.status, headers: EDGE_CORS_HEADERS });
}

export function membershipError(message: string, status: number) {
  return NextResponse.json({ message, statusCode: status }, { status, headers: EDGE_CORS_HEADERS });
}
