/**
 * Daily cron body used by `frontend/custom-worker.js`.
 * POSTs to the Worker’s own /api/membership/cron with X-Cron-Secret from env.
 * The secret is never hard-coded.
 *
 * @param {{ fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response> | Response }} handler
 * @param {{ cron?: string }} controller
 * @param {Record<string, unknown>} env
 * @param {{ waitUntil: (p: Promise<unknown>) => void }} ctx
 */
export async function runMembershipScheduled(handler, controller, env, ctx) {
  const secret = String(env.MEMBERSHIP_CRON_SECRET ?? "").trim();
  if (!secret) {
    console.error("[membership-cron] MEMBERSHIP_CRON_SECRET is not set; skipping scheduled run");
    return;
  }
  const origin = String(env.CRON_INTERNAL_ORIGIN ?? "https://b2ccoop-webapp.internal").replace(/\/$/, "");
  const req = new Request(`${origin}/api/membership/cron`, {
    method: "POST",
    headers: { "X-Cron-Secret": secret, "Content-Type": "application/json" },
    body: "{}",
  });
  ctx.waitUntil(
    Promise.resolve(handler.fetch(req, env, ctx)).then(async (res) => {
      const text = await res.text().catch(() => "");
      if (!res.ok) console.error(`[membership-cron] ${controller.cron} failed: ${res.status} ${text.slice(0, 300)}`);
      else console.log(`[membership-cron] ${controller.cron} ok: ${text.slice(0, 300)}`);
    }),
  );
}
