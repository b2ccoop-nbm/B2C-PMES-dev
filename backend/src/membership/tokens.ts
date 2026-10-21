import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { RESUME_TOKEN_TTL_DAYS } from "./validators";

export function generateResumeToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashResumeToken(token: string): string {
  return createHash("sha256").update(String(token ?? ""), "utf8").digest("hex");
}

export function tokensMatch(plain: string, hash: string): boolean {
  const a = Buffer.from(hashResumeToken(plain), "hex");
  const b = Buffer.from(String(hash ?? ""), "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
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

export function resumeCookie(token: string, opts?: { secure?: boolean }): string {
  const secure = opts?.secure ?? process.env.NODE_ENV === "production";
  return `b2c_membership_resume=${encodeURIComponent(token)}; Path=/; Max-Age=${RESUME_TOKEN_TTL_DAYS * 24 * 3600}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function resumeTokenFromCookieHeader(cookieHeader?: string | null): string {
  const cookie = String(cookieHeader ?? "");
  const m = cookie.match(/(?:^|;\s*)b2c_membership_resume=([^;]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : "";
}

export function generateUnusablePassword(): string {
  return randomBytes(32).toString("base64url");
}

export function clientIpFromRequest(headers: Record<string, string | string[] | undefined>, fallback = "0.0.0.0"): string {
  const xf = headers["x-forwarded-for"];
  const raw = Array.isArray(xf) ? xf[0] : xf;
  if (raw) return raw.split(",")[0]!.trim().slice(0, 64);
  const real = headers["x-real-ip"];
  const r = Array.isArray(real) ? real[0] : real;
  return (r ?? fallback).toString().slice(0, 64);
}
