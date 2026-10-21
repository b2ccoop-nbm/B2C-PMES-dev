import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

/**
 * OpenNext Worker: Edge API routes + Next shell (see `app/page.jsx`). Production member/marketing UI is the
 * **Vite** app (`npm run vite:build` → `dist/`), deployed to **Cloudflare Pages** — not bundled here.
 * Do **not** add catch-all rewrites to `/index.html` expecting the Vite bundle: those assets are not in
 * `.open-next/assets` unless you copy `dist` into the deploy pipeline. Point `b2ccoop.com` at the Pages
 * project; keep this Worker for `/api/*` (or a `*.workers.dev` host).
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * CORS: set only in `middleware.ts` (and `OPTIONS` / helpers on specific routes). Do **not** duplicate
   * `Access-Control-Allow-Origin` here — Next `headers()` + middleware both apply → `*, *` and browsers reject.
   */
  /** Same URL path as Nest (`POST /auth/sync-member`) so the Vite client does not need changes. */
  async rewrites() {
    return [
      { source: "/ai/landing-chat", destination: "/api/ai/landing-chat" },
      { source: "/auth/admin/login", destination: "/api/auth/admin/login" },
      { source: "/auth/staff/admins", destination: "/api/auth/staff/admins" },
      { source: "/auth/staff/password", destination: "/api/auth/staff/password" },
      { source: "/auth/staff/firebase-session", destination: "/api/auth/staff/firebase-session" },
      { source: "/auth/staff/member-position", destination: "/api/auth/staff/member-position" },
      { source: "/auth/staff/superusers/promote", destination: "/api/auth/staff/superusers/promote" },
      { source: "/auth/sync-member", destination: "/api/auth/sync-member" },
      { source: "/health", destination: "/api/health" },
      { source: "/pmes/admin/records", destination: "/api/pmes/admin/records" },
      { source: "/pmes/admin/records/:path*", destination: "/api/pmes/admin/records/:path*" },
      { source: "/pmes/admin/membership-pipeline", destination: "/api/pmes/admin/membership-pipeline" },
      { source: "/pmes/admin/participant/membership", destination: "/api/pmes/admin/participant/membership" },
      { source: "/pmes/admin/member-registry", destination: "/api/pmes/admin/member-registry" },
      { source: "/pmes/admin/legacy-pioneer", destination: "/api/pmes/admin/legacy-pioneer" },
      { source: "/pmes/admin/participants/:path*", destination: "/api/pmes/admin/participants/:path*" },
      { source: "/pmes/submit", destination: "/api/pmes/submit" },
      { source: "/pmes/full-profile", destination: "/api/pmes/full-profile" },
      { source: "/pmes/loi", destination: "/api/pmes/loi" },
      { source: "/pmes/certificate", destination: "/api/pmes/certificate" },
      { source: "/pmes/membership-lifecycle", destination: "/api/pmes/membership-lifecycle" },
      { source: "/pmes/member/resolve-login-email", destination: "/api/pmes/member/resolve-login-email" },
      { source: "/pmes/member/callsign", destination: "/api/pmes/member/callsign" },
      { source: "/pmes/pioneer/check-eligibility", destination: "/api/pmes/pioneer/check-eligibility" },
      { source: "/membership/:path*", destination: "/api/membership/:path*" },
      { source: "/pmes/admin/membership-applications", destination: "/api/pmes/admin/membership-applications" },
      { source: "/pmes/admin/membership-applications/:path*", destination: "/api/pmes/admin/membership-applications/:path*" },
      { source: "/pmes/admin/participant/secretary-confirm", destination: "/api/pmes/admin/participant/secretary-confirm" },
      { source: "/pmes/admin/participant/bod-vote", destination: "/api/pmes/admin/participant/bod-vote" },
      { source: "/pmes/admin/participant/membership-payment", destination: "/api/pmes/admin/participant/membership-payment" },
      { source: "/pmes/member/basic-profile", destination: "/api/pmes/member/basic-profile" },
    ];
  },
};

initOpenNextCloudflareForDev();

export default nextConfig;
