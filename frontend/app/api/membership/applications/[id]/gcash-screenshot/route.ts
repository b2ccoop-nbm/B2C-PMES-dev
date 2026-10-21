import { edgeCorsOptions } from "@/lib/edge-cors";
import { attachScreenshot } from "@/lib/membership/edge-service";
import { membershipError, membershipJson } from "@/lib/membership/http";
import { storeGcashScreenshot, validateScreenshotFile } from "@/lib/membership/screenshot";
import { resumeTokenFromRequest } from "@/lib/membership/tokens";

export function OPTIONS() {
  return edgeCorsOptions();
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const contentType = request.headers.get("content-type") ?? "";
  let token = resumeTokenFromRequest(request, null);
  let key = "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    token = token || String(form.get("resumeToken") ?? "");
    const file = form.get("file");
    if (file instanceof File) {
      const err = validateScreenshotFile(file.type, file.size);
      if (err) return membershipError(err, 400);
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        key = await storeGcashScreenshot({ applicationId: id, bytes, contentType: file.type });
      } catch (e) {
        return membershipError(e instanceof Error ? e.message : "Upload failed", 503);
      }
    }
  } else {
    const body = (await request.json().catch(() => ({}))) as { resumeToken?: string; objectKey?: string };
    token = resumeTokenFromRequest(request, body.resumeToken);
    key = String(body.objectKey ?? "").trim();
  }
  if (!token) return membershipError("Resume token is required.", 401);
  if (!key) return membershipError("Screenshot file is required.", 400);
  return membershipJson(await attachScreenshot(id, token, key));
}
