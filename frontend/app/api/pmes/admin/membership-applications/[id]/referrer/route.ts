import { edgeCorsOptions } from "@/lib/edge-cors";
import { adminPatchReferrer } from "@/lib/membership/edge-service";
import { membershipJson } from "@/lib/membership/http";
import { requireStaff, unauthorized } from "@/lib/staff-edge-auth";

export function OPTIONS() {
  return edgeCorsOptions();
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const staff = await requireStaff(request);
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as { referredByParticipantId?: string | null };
    return membershipJson(await adminPatchReferrer(id, staff, body.referredByParticipantId ?? null));
  } catch (e) {
    return unauthorized(e instanceof Error ? e.message : "Unauthorized");
  }
}
