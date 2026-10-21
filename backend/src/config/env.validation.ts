import * as Joi from "joi";

/** Loaded from process.env before the app boots; fails fast on misconfiguration. */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid("development", "production", "test").default("development"),
  PORT: Joi.number().port().default(3000),
  DATABASE_URL: Joi.string().required().messages({
    "any.required": "DATABASE_URL is required (PostgreSQL connection string)",
  }),
  /** Same DB as DATABASE_URL for local dev; on Neon use the direct (non-pooled) hostname for `prisma migrate`. */
  DIRECT_URL: Joi.string().required().messages({
    "any.required": "DIRECT_URL is required — use same value as DATABASE_URL locally; Neon provides a separate direct URL",
  }),
  /**
   * TTS backend: `noop` (no paid calls), `gemini`, `openai`, `grok` (xAI Grok TTS at api.x.ai).
   */
  AI_PROVIDER: Joi.string().valid("noop", "gemini", "openai", "grok").default("noop"),
  GEMINI_API_KEY: Joi.string().allow(""),
  GEMINI_TTS_MODEL: Joi.string().allow(""),
  OPENAI_API_KEY: Joi.string().allow(""),
  OPENAI_TTS_MODEL: Joi.string().allow(""),
  /** xAI / Grok — https://console.x.ai */
  XAI_API_KEY: Joi.string().allow(""),

  /** HS256 secret for staff JWTs (POST /auth/admin/login, /auth/staff/*). */
  ADMIN_JWT_SECRET: Joi.string().min(32).required(),

  /** Optional: require `X-Member-Sync-Secret` on POST /auth/sync-member (set in production). */
  MEMBER_SYNC_SECRET: Joi.string().allow(""),

  /** Optional: Firebase Admin (service account) — verify `Authorization: Bearer <idToken>` on POST /auth/sync-member. */
  FIREBASE_PROJECT_ID: Joi.string().allow(""),
  FIREBASE_CLIENT_EMAIL: Joi.string().allow(""),
  FIREBASE_PRIVATE_KEY: Joi.string().allow(""),

  /** B2CCoop Accounting integration (optional until accounting API is deployed). */
  ACCOUNTING_API_URL: Joi.string().uri().allow(""),
  ACCOUNTING_INTEGRATION_SECRET: Joi.string().allow(""),
  /** Default ₱1,500 — share + membership fee posted when Treasurer confirms payment. */
  INITIAL_MEMBERSHIP_FEE_AMOUNT: Joi.number().positive().default(1500),
  /** ₱500/year membership fee (posted separately from share capital). */
  ANNUAL_MEMBERSHIP_FEE_AMOUNT: Joi.number().positive().default(500),
  /** ₱100/month minimum share capital build-up. */
  MONTHLY_SHARE_CAPITAL_AMOUNT: Joi.number().positive().default(100),
  /** Initial share capital lump (default ₱1,000 = 10 months at ₱100). */
  INITIAL_SHARE_CAPITAL_AMOUNT: Joi.number().positive().default(1000),

  /** External store checkout webhook → accounting (optional until store is live). */
  STORE_CHECKOUT_WEBHOOK_SECRET: Joi.string().allow(""),

  /** B2C-Store service auth — GET /integrations/v1/members/resolve */
  STORE_INTEGRATION_SECRET: Joi.string().allow(""),

  TURNSTILE_SECRET_KEY: Joi.string().allow(""),
  MEMBERSHIP_CRON_SECRET: Joi.string().allow(""),
  DPA_CONSENT_VERSION: Joi.string().allow(""),
  PUBLIC_APP_URL: Joi.string().allow(""),
  MEMBERSHIP_FIREBASE_MOCK: Joi.string().allow(""),
})
  .custom((value, helpers) => {
    const v = value as {
      AI_PROVIDER?: string;
      GEMINI_API_KEY?: string;
      OPENAI_API_KEY?: string;
      XAI_API_KEY?: string;
    };
    const p = v.AI_PROVIDER;
    if (p === "gemini" && !String(v.GEMINI_API_KEY ?? "").trim()) {
      return helpers.error("any.custom", {
        message: "GEMINI_API_KEY is required when AI_PROVIDER=gemini (or use noop / openai / grok)",
      });
    }
    if (p === "openai" && !String(v.OPENAI_API_KEY ?? "").trim()) {
      return helpers.error("any.custom", {
        message: "OPENAI_API_KEY is required when AI_PROVIDER=openai",
      });
    }
    if (p === "grok" && !String(v.XAI_API_KEY ?? "").trim()) {
      return helpers.error("any.custom", {
        message: "XAI_API_KEY is required when AI_PROVIDER=grok",
      });
    }
    return value;
  })
  .messages({
    "any.custom": "{{#message}}",
  });
