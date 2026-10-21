import { EDGE_CORS_HEADERS, edgeCorsOptions } from "@/lib/edge-cors";
import { adminListApplications } from "@/lib/membership/edge-service";
import { canAccessMembershipApplications } from "@/lib/membership/staff-access";
import { forbidden, requireStaff, unauthorized } from "@/lib/staff-edge-auth";
import { NextResponse } from "next/server";

export function OPTIONS() {
  return edgeCorsOptions();
}

export async function GET(request: Request) {
  try {
    const staff = await requireStaff(request);
    if (!canAccessMembershipApplications(staff.role)) {
      return forbidden("Only Treasurer, Secretary, or Superuser may list online applications.", EDGE_CORS_HEADERS);
    }
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
