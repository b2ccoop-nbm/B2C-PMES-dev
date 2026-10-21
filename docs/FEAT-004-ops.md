# FEAT-004 operations notes (do not apply to production from this PR)

Nilo-only merge. Prisma migrations in this PR must **not** be applied to live Neon `neondb`.

## Pre-check before unique `memberIdNo`

Run on a **staging / disposable** Neon branch only:

```bash
psql "$STAGING_DATABASE_URL" -f backend/scripts/report-duplicate-member-id-no.sql
psql "$STAGING_DATABASE_URL" -f backend/scripts/report-duplicate-tin-no.sql
```

Resolve any duplicate `memberIdNo` or `tinNo` rows before deploying the unique indexes. The migration normalizes blank values to NULL first and aborts if duplicates remain. Do not apply it to live Neon from this PR.

## Secrets to set after merge (Worker + Nest)

| Secret | Purpose |
|---|---|
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile verify on create + submit |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `VITE_TURNSTILE_SITE_KEY` | Browser widget (optional until enabled) |
| `MEMBERSHIP_CRON_SECRET` | Required. Cron **fails closed** (401) if unset or wrong |
| `PUBLIC_APP_URL` | Used in on-screen continue links (`/register/continue#c=…`) |
| `MEMBERSHIP_UPLOADS` | R2 bucket binding (private GCash screenshots) |
| Existing `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Server-side `accounts:signUp` + `accounts:sendOobCode` |

There is **no Gmail OAuth**. Applicant set-password mail is Firebase Auth only: Identity Toolkit `sendOobCode` with `requestType=PASSWORD_RESET` (no `returnOobLink`). Firebase's project email templates send the message.

Draft continue links **cannot** use Firebase templates: `EMAIL_SIGNIN` would create a Firebase user before submit. The continue URL is shown on screen once when a new draft is created, stored on that device, and shown again in the member portal checklist when this browser saved it. Public create on an existing email never returns a token or a link (C1).

Treasurer / staff notices are **in-app only**: the Payments to confirm badge + queue, plus `inbox.treasurerNotice` after the cron stamps `treasurerNotifiedAt`. Approval and rejection stay in the member portal; they are not emailed.

Turnstile verify **fails closed** when `TURNSTILE_SECRET_KEY` is unset (except `NODE_ENV=test`). CORS is an allowlist (`b2ccoop.com` + localhost + `PUBLIC_APP_URL` / `MEMBERSHIP_CORS_ORIGINS`), never `*`. Resume tokens are hashed and expire in 30 days. Drafts are expired **and purged** at 60 days from `createdAt`.

## Cloudflare WAF (document only — do not attach to prod in this PR)

Suggested rate-limit rule on the API Worker:

- Match: `http.request.uri.path matches "^/api/membership/"` or rewritten `/membership/`
- Limit: 60 requests / 1 minute / IP
- Action: Block or Challenge (Turnstile)

App-level limits (Neon `MembershipRateLimit`) already enforce:

- 5 draft creates / IP / hour
- 3 submits / email / day
- 30 referrer lookups / IP / hour

## Scheduled Worker (dev / later prod)

`POST /api/membership/cron` with `X-Cron-Secret`:

1. Expire + purge drafts older than 60 days
2. Stamp `treasurerNotifiedAt` on submitted, declared-paid, unconfirmed applications (in-app reminder flag; no email)

Example Wrangler trigger (do not deploy from this PR):

```jsonc
"triggers": { "crons": ["0 16 * * *"] }
```

## Manual QA checklist

- [ ] Cash happy path
- [ ] GCash with screenshot
- [ ] GCash without screenshot
- [ ] Submit before paying
- [ ] Treasurer queue + in-app notice (no staff email)
- [ ] Secretary blocked until PMES passed
- [ ] Superuser force override logged
- [ ] TIN prompt on every sign-in until saved
- [ ] Under-18 rejected
- [ ] Non-approved referrer rejected
- [ ] Draft expiry at 60 days (cron)
- [ ] Auto-save resume on a second device via on-screen continue link
- [ ] Duplicate email / mobile / TIN / name+DOB / legacy reclaim
- [ ] FEAT-003 referral credit still fires once (`referralJoinCreditedAt` set-once)
- [ ] Reject path updates status in-app only
- [ ] `memberIdNo` uniqueness + collision retry
- [ ] Mobile viewport (Android Chrome / iOS Safari)
- [ ] Submit sends Firebase password-reset email (not Gmail API)
