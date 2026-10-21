import { edgeCorsOptions } from "@/lib/edge-cors";
import { adminReject } from "@/lib/membership/edge-service";
import { membershipJson } from "@/lib/membership/http";
import { requireStaff, unauthorized } from "@/lib/staff-edge-auth";

export function OPTIONS() {
  return edgeCorsOptions();
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const staff = await requireStaff(request);
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    return membershipJson(await adminReject(id, staff, String(body.reason ?? "")));
  } catch (e) {
    return unauthorized(e instanceof Error ? e.message : "Unauthorized");
  }
}
