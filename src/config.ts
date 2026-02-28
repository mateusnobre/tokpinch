import { z } from "zod";
import crypto from "node:crypto";

/**
 * Coerces a string "true"/"false" to boolean, also handles actual booleans.
 */
const booleanString = (defaultVal: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .transform((v) => {
      if (typeof v === "boolean") return v;
      return v.toLowerCase() === "true";
    })
    .default(defaultVal);

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // Provider API keys — TokPinch forwards the CALLER's key, so these are
  // optional here. They're only used if you want TokPinch to inject a key
  // for clients that don't supply one (advanced use).  Never logged.
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY:    z.string().optional(),

  // Dashboard auth
  DASHBOARD_PASSWORD: z
    .string()
    .min(8, "DASHBOARD_PASSWORD must be at least 8 characters."),
  JWT_SECRET: z
    .string()
    .optional()
    .transform((v) => v ?? crypto.randomBytes(64).toString("hex")),

  // CORS — comma-separated list of allowed origins in production.
  // In development, localhost variants are always allowed.
  // Example: "https://dash.example.com,https://proxy.example.com"
  ALLOWED_ORIGINS: z.string().optional(),

  // Proxy rate limit — max requests per minute per IP to /v1/* and /openai/v1/*
  PROXY_RATE_LIMIT: z.coerce.number().int().positive().default(300),

  // Budget controls (USD)
  BUDGET_DAILY: z.coerce.number().positive().optional(),
  BUDGET_MONTHLY: z.coerce.number().positive().optional(),

  // Telegram alerts
  ALERT_TELEGRAM_TOKEN: z.string().optional(),
  ALERT_TELEGRAM_CHAT_ID: z.string().optional(),

  // Email alerts
  ALERT_EMAIL_TO: z.string().email().optional(),
  ALERT_EMAIL_SMTP_HOST: z.string().optional(),
  ALERT_EMAIL_SMTP_PORT: z.coerce.number().int().default(587),
  ALERT_EMAIL_SMTP_USER: z.string().optional(),
  ALERT_EMAIL_SMTP_PASS: z.string().optional(),

  // Feature flags
  SMART_ROUTING_ENABLED:  booleanString(false),
  LOOP_DETECTION_ENABLED: booleanString(true),

  // Loop detection tuning
  LOOP_MAX_RPM:          z.coerce.number().int().positive().default(20),
  LOOP_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(300),

  // Storage
  DB_PATH: z.string().default("./data/tokpinch.db"),
});

function loadConfig() {
  // dotenv sets unset vars to "" — convert them to undefined so optional
  // fields like BUDGET_DAILY, ALERT_EMAIL_TO etc pass validation correctly.
  const rawEnv = Object.fromEntries(
    Object.entries(process.env).map(([k, v]) => [k, v === "" ? undefined : v])
  );

  const result = envSchema.safeParse(rawEnv);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    // Use process.stderr so it's visible even if the logger hasn't init'd yet
    process.stderr.write(
      `\n[tokpinch] Configuration error — startup aborted:\n${issues}\n\n`
    );
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();

export type Config = typeof config;
