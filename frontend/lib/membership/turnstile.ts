export async function verifyTurnstile(
  token: string | null | undefined,
  ip?: string,
): Promise<{ ok: boolean; skipped: boolean; message?: string }> {
  const secret = String(process.env.TURNSTILE_SECRET_KEY ?? "").trim();
  if (!secret) return { ok: true, skipped: true };
  const t = String(token ?? "").trim();
  if (!t) return { ok: false, skipped: false, message: "Captcha verification is required." };
  const body = new URLSearchParams({ secret, response: t });
  if (ip) body.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as { success?: boolean };
  if (!json.success) return { ok: false, skipped: false, message: "Captcha verification failed." };
  return { ok: true, skipped: false };
}
