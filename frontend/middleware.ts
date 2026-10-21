import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { edgeCorsHeaders } from "@/lib/edge-cors";

/**
 * CORS for the Edge API. The Vite client uses **rewritten** paths from `next.config.mjs`
 * (`/pmes/...`, `/health`, `/auth/sync-member`, …) — not `/api/...` — so matchers must include
 * those prefixes. Matching only `/api/*` left browser cross-origin fetches without ACAO → "Failed to fetch".
 */
function withCors(request: NextRequest, response: NextResponse) {
  const headers = edgeCorsHeaders(request.headers.get("origin"));
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  return response;
}

export function middleware(request: NextRequest) {
  if (request.method === "OPTIONS") {
    return withCors(request, new NextResponse(null, { status: 204 }));
  }
  return withCors(request, NextResponse.next());
}

export const config = {
  matcher: [
    "/api/:path*",
    "/pmes/:path*",
    "/membership/:path*",
    "/health",
    "/auth/:path*",
    "/ai/:path*",
  ],
};
