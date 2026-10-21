import { NextResponse } from "next/server";

const DEFAULT_ORIGINS = [
  "https://b2ccoop.com",
  "https://www.b2ccoop.com",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:3040",
  "http://localhost:4173",
];

export function allowedCorsOrigins(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): string[] {
  const extras = String(env.MEMBERSHIP_CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const pub = String(env.PUBLIC_APP_URL ?? "")
    .trim()
    .replace(/\/$/, "");
  return [...new Set([...DEFAULT_ORIGINS, pub, ...extras].filter(Boolean))];
}

export function isAllowedCorsOrigin(
  origin: string | null | undefined,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): boolean {
  if (!origin) return false;
  return allowedCorsOrigins(env).includes(origin.replace(/\/$/, ""));
}

export function edgeCorsHeaders(origin?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-member-sync-secret, X-Resume-Token, x-cron-secret",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
  if (origin && isAllowedCorsOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/** Shared CORS for Edge API routes. Never reflects `*`. */
export const EDGE_CORS_HEADERS: Record<string, string> = edgeCorsHeaders();

export function edgeCorsOptions(request?: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: edgeCorsHeaders(request?.headers.get("origin")) });
}
