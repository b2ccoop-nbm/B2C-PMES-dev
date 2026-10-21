const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 5 * 1024 * 1024;

export type ScreenshotMime = "image/jpeg" | "image/png" | "image/webp";

export function detectImageMime(bytes: Uint8Array): ScreenshotMime | null {
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
  return `membership/${applicationId}/${crypto.randomUUID()}.${ext}`;
}

export function validateScreenshotFile(type: string, size: number): string | null {
  if (!ALLOWED.has(type)) return "GCash screenshot must be JPEG, PNG, or WebP.";
  if (size > MAX_BYTES) return "GCash screenshot must be 5 MB or smaller.";
  return null;
}

export function validateScreenshotBytes(bytes: Uint8Array): { ok: true; mime: ScreenshotMime } | { ok: false; message: string } {
  if (bytes.byteLength > MAX_BYTES) return { ok: false, message: "GCash screenshot must be 5 MB or smaller." };
  const mime = detectImageMime(bytes);
  if (!mime) return { ok: false, message: "GCash screenshot must be JPEG, PNG, or WebP." };
  return { ok: true, mime };
}

export async function storeGcashScreenshot(opts: {
  applicationId: string;
  bytes: Uint8Array;
  contentType: string;
}): Promise<string> {
  const valid = validateScreenshotBytes(opts.bytes);
  if (!valid.ok) throw new Error(valid.message);
  const key = generateUploadKey(opts.applicationId, valid.mime);
  const mock =
    String(process.env.MEMBERSHIP_ALLOW_MOCK_UPLOADS ?? "").trim() === "1" ||
    String(process.env.MEMBERSHIP_FIREBASE_MOCK ?? "").trim() === "1";
  if (mock) return `mock:${key}`;

  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const ctx = await getCloudflareContext();
    const bucket = (ctx.env as { MEMBERSHIP_UPLOADS?: { put: (k: string, v: Uint8Array, o?: { httpMetadata?: { contentType: string } }) => Promise<void> } })
      .MEMBERSHIP_UPLOADS;
    if (!bucket) {
      throw new Error("Screenshot storage is not configured (R2 binding MEMBERSHIP_UPLOADS).");
    }
    await bucket.put(key, opts.bytes, { httpMetadata: { contentType: valid.mime } });
    return key;
  } catch (e) {
    if (mock) return `mock:${key}`;
    throw e instanceof Error ? e : new Error("Screenshot upload failed");
  }
}

export async function readGcashScreenshot(key: string): Promise<{ body: Uint8Array; contentType: string } | null> {
  if (key.startsWith("mock:")) return null;
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const ctx = await getCloudflareContext();
  const bucket = (ctx.env as { MEMBERSHIP_UPLOADS?: { get: (k: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null> } })
    .MEMBERSHIP_UPLOADS;
  if (!bucket) return null;
  const obj = await bucket.get(key);
  if (!obj) return null;
  return {
    body: new Uint8Array(await obj.arrayBuffer()),
    contentType: obj.httpMetadata?.contentType || "image/jpeg",
  };
}
