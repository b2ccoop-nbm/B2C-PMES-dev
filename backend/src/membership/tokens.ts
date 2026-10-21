import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

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
