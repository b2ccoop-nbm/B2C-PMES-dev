import { EDGE_CORS_HEADERS, edgeCorsOptions } from "@/lib/edge-cors";
import { adminListApplications } from "@/lib/membership/edge-service";
import { requireStaff, unauthorized } from "@/lib/staff-edge-auth";
import { NextResponse } from "next/server";

export function OPTIONS() {
  return edgeCorsOptions();
}

export async function GET(request: Request) {
  try {
    await requireStaff(request);
    const url = new URL(request.url);
    const body = await adminListApplications({
      status: url.searchParams.get("status") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
    });
    return NextResponse.json(body, { headers: EDGE_CORS_HEADERS });
  } catch (e) {
    return unauthorized(e instanceof Error ? e.message : "Unauthorized");
  }
}
