import { edgeCorsOptions } from "@/lib/edge-cors";
import { attachScreenshot } from "@/lib/membership/edge-service";
import { membershipError, membershipJson } from "@/lib/membership/http";
import { storeGcashScreenshot, validateScreenshotBytes } from "@/lib/membership/screenshot";
import { resumeTokenFromRequest } from "@/lib/membership/tokens";

export function OPTIONS(request: Request) {
  return edgeCorsOptions(request);
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const contentType = request.headers.get("content-type") ?? "";
  let token = resumeTokenFromRequest(request, null);
  if (!contentType.includes("multipart/form-data")) {
    return membershipError("Upload a JPEG, PNG, or WebP file. Client object keys are not accepted.", 400, request);
  }
  const form = await request.formData();
  token = token || String(form.get("resumeToken") ?? "");
  const file = form.get("file");
  if (!(file instanceof File)) return membershipError("Screenshot file is required.", 400, request);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const valid = validateScreenshotBytes(bytes);
  if (!valid.ok) return membershipError(valid.message, 400, request);
  if (!token) return membershipError("Resume token is required.", 401, request);
  let key = "";
  try {
    key = await storeGcashScreenshot({ applicationId: id, bytes, contentType: valid.mime });
  } catch (e) {
    return membershipError(e instanceof Error ? e.message : "Upload failed", 503, request);
  }
  return membershipJson(await attachScreenshot(id, token, key), request);
}
