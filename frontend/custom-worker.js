// Custom Worker entry: wraps the OpenNext worker and adds a scheduled() handler
// so the daily cron trigger (wrangler "triggers.crons") runs the FEAT-004
// membership maintenance job (expire/purge 60-day drafts, stamp treasurer notices).
// The cron secret is read from the Worker's own env (MEMBERSHIP_CRON_SECRET);
// it is never hard-coded here.
// @ts-ignore `.open-next/worker.js` is generated at build time by `opennextjs-cloudflare build`
import { default as handler } from "./.open-next/worker.js";
import { runMembershipScheduled } from "./lib/membership/scheduled-handler.js";

const worker = {
  fetch: handler.fetch,

  async scheduled(controller, env, ctx) {
    await runMembershipScheduled(handler, controller, env, ctx);
  },
};

export default worker;

// Re-export the Durable Object classes OpenNext emits so bindings keep working.
// @ts-ignore generated at build time
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "./.open-next/worker.js";
