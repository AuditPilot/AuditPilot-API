import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";

/**
 * Central environment validation.
 *
 * Rules of thumb:
 * - Production boots are FAILED on missing critical secrets (no silent fallbacks).
 * - Development gets loud warnings + safe ephemeral/dev conveniences so the app
 *   still boots with zero configuration.
 * - Secrets are never logged here.
 */

const hexRange = (min: number) =>
  z
    .string()
    .regex(
      new RegExp(`^[0-9a-fA-F]{${min},}$`),
      `must be at least ${min} hex characters`,
    );

/**
 * Treat an explicitly-empty env value ("VAR=") the same as unset â€”
 * compose / `docker run -e VAR=` / shell exports commonly inject empty
 * strings for unconfigured optional providers, and empty strings should
 * de-activate a feature rather than fail validation.
 */
const emptyAsUndefined = (value: unknown) => (value === "" ? undefined : value);
const pre = <T extends z.ZodType>(schema: T) =>
  z.preprocess(emptyAsUndefined, schema);

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(5002),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  MONGODB_URI: z
    .string()
    .min(1)
    .default("mongodb://localhost:27017/auditpilot"),

  JWT_SECRET: pre(z.string().min(1).optional()),

  // 32-byte key for AES-256-GCM token encryption (added in the security step)
  ENCRYPTION_KEY: pre(hexRange(32).optional()),

  // GitHub OAuth App (legacy mode)
  GITHUB_CLIENT_ID: pre(z.string().min(1).optional()),
  GITHUB_CLIENT_SECRET: pre(z.string().min(1).optional()),
  GITHUB_REDIRECT_URI: pre(z.string().url().optional()),

  // GitHub App (new mode)
  GITHUB_APP_ID: pre(z.string().min(1).optional()),
  GITHUB_APP_PRIVATE_KEY_BASE64: pre(z.string().optional()),
  GITHUB_APP_NAME: pre(z.string().optional()),
  GITHUB_WEBHOOK_SECRET: pre(z.string().min(1).optional()),

  GITHUB_AUTH_MODE: z.enum(["oauth", "app"]).default("oauth"),

  // Stripe
  STRIPE_SECRET_KEY: pre(z.string().min(1).optional()),
  STRIPE_WEBHOOK_SECRET: pre(z.string().min(1).optional()),
  STRIPE_PRO_PRICE_ID: pre(z.string().min(1).optional()),
  STRIPE_AGENCY_PRICE_ID: pre(z.string().min(1).optional()),

  // AI (OpenAI-compatible endpoint, OpenRouter by default)
  AI_INTEGRATIONS_OPENAI_API_KEY: pre(z.string().min(1).optional()),
  AI_INTEGRATIONS_OPENAI_BASE_URL: pre(
    z.string().url().default("https://openrouter.ai/api/v1"),
  ),
  AI_MODEL_TRIAGE: pre(z.string().min(1).optional()),
  AI_MODEL_DEEP: pre(z.string().min(1).optional()),

  // Comma-separated CORS allowlist for browser clients
  CLIENT_ORIGIN: pre(
    z.string().min(1).default("http://localhost:5000,http://localhost:5173"),
  ),

  // Cookie SameSite policy for the auth cookies. "lax" (default) fits
  // same-site deployments (SPA and API share a parent domain, or are
  // proxied on one origin). "none" is required when the API serves a
  // different SITE (api.example.com â‰  app.example.com) â€” with "none" the
  // Secure flag is forced on (browsers reject insecure SameSite=none).
  COOKIE_SAMESITE: z
    .enum(["lax", "none", "strict"])
    .default("lax"),

  APP_URL: pre(z.string().url().optional()),

  // Set to "0"/"false" on API-only deployments where the static SPA is
  // served elsewhere (nginx / CDN â€” see the standalone API Dockerfile).
  SERVE_STATIC: z
    .string()
    .optional()
    .transform(v => v !== "0" && v !== "false"),

  WORKER_ONLY: z
    .string()
    .optional()
    .transform(v => v === "1" || v === "true"),
  DISABLE_WORKERS: z
    .string()
    .optional()
    .transform(v => v === "1" || v === "true"),
});

export type EnvSource = Record<string, string | undefined>;
export type AppEnv = z.infer<typeof envSchema>;

/** Pure parser â€” exported for testability (see env.test.ts). */
export function parseEnv(source: EnvSource): {
  ok: boolean;
  env?: AppEnv;
  errors?: z.ZodError;
  warnings: { field: string; message: string }[];
} {
  const warnings: { field: string; message: string }[] = [];
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    return { ok: false, warnings, errors: parsed.error };
  }

  const env = parsed.data;
  const isProd = env.NODE_ENV === "production";

  if (isProd && !env.JWT_SECRET) {
    return {
      ok: false,
      warnings,
      errors: new z.ZodError([
        {
          code: "custom",
          path: ["JWT_SECRET"],
          message:
            "JWT_SECRET is required in production. Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
        },
      ]),
    };
  }

  if (!env.JWT_SECRET) {
    warnings.push({
      field: "JWT_SECRET",
      message:
        "not set â€” an EPHEMERAL secret was generated for this boot only (dev convenience). Sessions reset on restart. Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    });
  } else if (env.JWT_SECRET.length < 32 && isProd) {
    warnings.push({
      field: "JWT_SECRET",
      message: "should be at least 32 characters in production",
    });
  }

  if (isProd && !env.ENCRYPTION_KEY) {
    return {
      ok: false,
      warnings,
      errors: new z.ZodError([
        {
          code: "custom",
          path: ["ENCRYPTION_KEY"],
          message:
            "ENCRYPTION_KEY is required in production (64 hex chars). Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
        },
      ]),
    };
  }

  return { ok: true, env, warnings };
}

function ephemeralSecret(): string {
  // Generated at boot, never persisted, never logged.
  return randomBytes(32).toString("hex");
}

let cached: AppEnv | null = null;

/** Validates once at module load and freezes the result. */
export function env(): AppEnv {
  if (cached) {
    return cached;
  }

  const result = parseEnv(process.env);

  if (!result.ok) {
    const details = result.errors!.issues
      .map(i => `- ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`\n[config] Invalid environment:\n${details}\n`);
    process.exit(1);
  }

  for (const w of result.warnings) {
    console.warn(`[config] ${w.field}: ${w.message}`);
  }

  // Dev conveniences (safe fallbacks, no hardcoded secrets):
  const e = result.env!;
  if (!e.JWT_SECRET) {
    e.JWT_SECRET = ephemeralSecret();
  }
  if (!e.ENCRYPTION_KEY && e.JWT_SECRET) {
    // dev-only deterministic derivation so encrypted dev data keeps decrypting;
    // production requires an explicit ENCRYPTION_KEY.
    e.ENCRYPTION_KEY = createHash("sha256").update(`enc:${e.JWT_SECRET}`).digest("hex");
    console.warn(
      "[config] ENCRYPTION_KEY not set â€” derived from JWT_SECRET (dev convenience only).",
    );
  }

  cached = Object.freeze(e);
  return cached;
}

const parsed = env();
export const ENV = parsed;
export const isProd = parsed.NODE_ENV === "production";
export const isDev = parsed.NODE_ENV === "development";
export const isTest = parsed.NODE_ENV === "test";

/** Parsed CORS allowlist. */
export const CLIENT_ORIGINS: string[] = parsed.CLIENT_ORIGIN.split(",")
  .map(s => s.trim())
  .filter(Boolean);



