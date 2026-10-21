import { getSql } from "@/lib/db";
import { EDGE_CORS_HEADERS, edgeCorsOptions } from "@/lib/edge-cors";
import { readGcashScreenshot } from "@/lib/membership/screenshot";
import { canAccessMembershipApplications } from "@/lib/membership/staff-access";
import { forbidden, requireStaff, unauthorized } from "@/lib/staff-edge-auth";
import { NextResponse } from "next/server";

export function OPTIONS() {
  return edgeCorsOptions();
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const staff = await requireStaff(request);
    if (!canAccessMembershipApplications(staff.role)) {
      return forbidden("Only Treasurer, Secretary, or Superuser may view GCash screenshots.", EDGE_CORS_HEADERS);
    }
    const { id } = await ctx.params;
    const sql = getSql();
    const rows = await sql`SELECT "gcashScreenshotKey" FROM "MembershipApplication" WHERE id = ${id} LIMIT 1`;
    const key = (rows as { gcashScreenshotKey: string | null }[])[0]?.gcashScreenshotKey;
    if (!key) return NextResponse.json({ message: "No screenshot" }, { status: 404, headers: EDGE_CORS_HEADERS });
    const file = await readGcashScreenshot(key);
    if (!file) {
      return NextResponse.json({ message: "Screenshot not available" }, { status: 404, headers: EDGE_CORS_HEADERS });
    }
    return new NextResponse(Buffer.from(file.body), {
      headers: { ...EDGE_CORS_HEADERS, "Content-Type": file.contentType, "Cache-Control": "private, max-age=60" },
    });
  } catch (e) {
    return unauthorized(e instanceof Error ? e.message : "Unauthorized");
  }
}
