import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * CORS for the Edge API. The Vite client uses **rewritten** paths from `next.config.mjs`
 * (`/pmes/...`, `/health`, `/auth/sync-member`, …) — not `/api/...` — so matchers must include
 * those prefixes. Matching only `/api/*` left browser cross-origin fetches without ACAO → "Failed to fetch".
 */
function withCors(response: NextResponse) {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-member-sync-secret, X-Resume-Token, x-cron-secret");
  return response;
}

export function middleware(request: NextRequest) {
  if (request.method === "OPTIONS") {
    return withCors(new NextResponse(null, { status: 204 }));
  }
  return withCors(NextResponse.next());
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
