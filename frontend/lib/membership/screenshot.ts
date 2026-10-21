const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 5 * 1024 * 1024;

export function validateScreenshotFile(type: string, size: number): string | null {
  if (!ALLOWED.has(type)) return "GCash screenshot must be JPEG, PNG, or WebP.";
  if (size > MAX_BYTES) return "GCash screenshot must be 5 MB or smaller.";
  return null;
}

export async function storeGcashScreenshot(opts: {
  applicationId: string;
  bytes: Uint8Array;
  contentType: string;
}): Promise<string> {
  const err = validateScreenshotFile(opts.contentType, opts.bytes.byteLength);
  if (err) throw new Error(err);
  const key = `membership/${opts.applicationId}/${crypto.randomUUID()}`;
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
    await bucket.put(key, opts.bytes, { httpMetadata: { contentType: opts.contentType } });
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
