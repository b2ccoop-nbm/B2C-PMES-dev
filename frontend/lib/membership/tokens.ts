export async function generateResumeToken(): Promise<string> {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function hashResumeToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(String(token ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateUnusablePassword(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function clientIpFromHeaders(headers: Headers): string {
  const xf = headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0]!.trim().slice(0, 64);
  return (headers.get("x-real-ip") ?? "0.0.0.0").slice(0, 64);
}

export function resumeTokenFromRequest(request: Request, bodyToken?: string | null): string {
  const header = request.headers.get("x-resume-token");
  if (header?.trim()) return header.trim();
  if (bodyToken?.trim()) return bodyToken.trim();
  const cookie = request.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)b2c_membership_resume=([^;]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : "";
}

export function resumeCookie(token: string): string {
  return `b2c_membership_resume=${encodeURIComponent(token)}; Path=/; Max-Age=${30 * 24 * 3600}; HttpOnly; SameSite=Lax`;
}
