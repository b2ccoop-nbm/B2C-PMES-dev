export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

export type ScreenshotMime = "image/jpeg" | "image/png" | "image/webp";

export function detectImageMime(bytes: Uint8Array | Buffer): ScreenshotMime | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  const riff = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  const webp = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
  if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  return null;
}

export function generateUploadKey(applicationId: string, mime: ScreenshotMime): string {
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : "webp";
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}`;
  return `membership/${applicationId}/${id}.${ext}`;
}

export function validateScreenshotBytes(bytes: Uint8Array | Buffer): { ok: true; mime: ScreenshotMime } | { ok: false; message: string } {
  if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
    return { ok: false, message: "GCash screenshot must be 5 MB or smaller." };
  }
  const mime = detectImageMime(bytes);
  if (!mime) return { ok: false, message: "GCash screenshot must be JPEG, PNG, or WebP." };
  return { ok: true, mime };
}
