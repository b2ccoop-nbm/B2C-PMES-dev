import { detectImageMime, generateUploadKey, validateScreenshotBytes } from "./screenshot";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

describe("screenshot validation", () => {
  it("detects jpeg/png/webp magic bytes and rejects others", () => {
    expect(detectImageMime(jpeg)).toBe("image/jpeg");
    expect(detectImageMime(png)).toBe("image/png");
    expect(detectImageMime(webp)).toBe("image/webp");
    expect(detectImageMime(Buffer.from("not-an-image"))).toBeNull();
  });

  it("enforces the 5 MB size limit and generates a server key", () => {
    const huge = Buffer.alloc(5 * 1024 * 1024 + 1, 0xff);
    huge[0] = 0xff;
    huge[1] = 0xd8;
    huge[2] = 0xff;
    expect(validateScreenshotBytes(huge).ok).toBe(false);
    expect(generateUploadKey("app-1", "image/png")).toMatch(/^membership\/app-1\/.+\.png$/);
  });
});
