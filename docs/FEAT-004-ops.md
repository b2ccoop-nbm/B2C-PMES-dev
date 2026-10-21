# FEAT-004 operations notes (do not apply to production from this PR)

Nilo-only merge. Prisma migrations in this PR must **not** be applied to live Neon `neondb`.

## Pre-check before unique `memberIdNo`

Run on a **staging / disposable** Neon branch only:

```bash
psql "$STAGING_DATABASE_URL" -f backend/scripts/report-duplicate-member-id-no.sql
```

Resolve any duplicate `memberIdNo` rows before deploying the unique index.

## Secrets to set after merge (Worker + Nest)

| Secret | Purpose |
|---|---|
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile verify on create + submit |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `VITE_TURNSTILE_SITE_KEY` | Browser widget (optional until enabled) |
| `GMAIL_SENDING_ENABLED` | `true` only after Nilo grants Gmail OAuth for **b2ccoop@gmail.com** |
| `GMAIL_OAUTH_CLIENT_ID` | Gmail API OAuth client |
| `GMAIL_OAUTH_CLIENT_SECRET` | Gmail API OAuth secret |
| `GMAIL_OAUTH_REFRESH_TOKEN` | Refresh token for b2ccoop@gmail.com |
| `GMAIL_FROM` | Default `b2ccoop@gmail.com` |
| `MEMBERSHIP_CRON_SECRET` | Protects `POST /membership/cron` |
| `PUBLIC_APP_URL` | Used in emailed continue / set-password links |
| `MEMBERSHIP_UPLOADS` | R2 bucket binding (private GCash screenshots) |
| Existing `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Server-side `accounts:signUp` + `sendOobCode` |

Until Gmail OAuth is granted, leave `GMAIL_SENDING_ENABLED` unset/false. The mailer returns `{ mocked: true }` and tests must keep it off.

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
2. Re-send Treasurer payment reminders for submitted, declared-paid, unconfirmed applications

Example Wrangler trigger (do not deploy from this PR):

```jsonc
"triggers": { "crons": ["0 16 * * *"] }
```

## Manual QA checklist

- [ ] Cash happy path
- [ ] GCash with screenshot
- [ ] GCash without screenshot
- [ ] Submit before paying
- [ ] Treasurer queue + notification (mail mocked until OAuth)
- [ ] Secretary blocked until PMES passed
- [ ] Superuser force override logged
- [ ] TIN prompt on every sign-in until saved
- [ ] Under-18 rejected
- [ ] Non-approved referrer rejected
- [ ] Draft expiry at 60 days (cron)
- [ ] Auto-save resume on a second device via emailed continue link
- [ ] Duplicate email / mobile / TIN / name+DOB / legacy reclaim
- [ ] FEAT-003 referral credit still fires once (`referralJoinCreditedAt` set-once)
- [ ] Reject path emails applicant
- [ ] `memberIdNo` uniqueness + collision retry
- [ ] Mobile viewport (Android Chrome / iOS Safari)
