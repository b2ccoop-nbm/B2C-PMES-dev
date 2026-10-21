export const RESUME_TOKEN_TTL_DAYS = 30;

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

export async function tokensMatch(plain: string, hash: string): Promise<boolean> {
  const a = await hashResumeToken(plain);
  const b = String(hash ?? "");
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function resumeTokenExpiresAt(now = new Date(), ttlDays = RESUME_TOKEN_TTL_DAYS): Date {
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
}

export function isResumeTokenExpired(expiresAt: Date | string | null | undefined, now = new Date()): boolean {
  if (!expiresAt) return true;
  const at = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return true;
  return at.getTime() <= now.getTime();
}

export function continueUrl(publicAppUrl: string, claimToken: string): string {
  const base = String(publicAppUrl ?? "").replace(/\/$/, "");
  return `${base}/register/continue#c=${encodeURIComponent(claimToken)}`;
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

export function resumeCookie(token: string, opts?: { secure?: boolean }): string {
  const secure = opts?.secure ?? process.env.NODE_ENV === "production";
  return `b2c_membership_resume=${encodeURIComponent(token)}; Path=/; Max-Age=${RESUME_TOKEN_TTL_DAYS * 24 * 3600}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}
