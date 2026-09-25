/**
 * Centralised configuration loaded from environment variables.
 * All secrets come from env - never hardcoded.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { z } from "zod";

// Dev env loader.
// When running via `tsx watch` through turbo/pnpm, shell env vars are NOT
// forwarded to child processes. This block reads infra/.env synchronously
// BEFORE Zod validation so DATABASE_URL etc. are available at parse time.
// It is strictly disabled in production: production must inject env vars
// directly, never from a bundled file.
if (
  process.env["NODE_ENV"] !== "production" &&
  !process.env["DATABASE_URL"]
) {
  const infraDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../infra");
  const fallbackEnvFiles = [".env.dev", ".env.sandbox", ".env"];

  for (const fileName of fallbackEnvFiles) {
    const envPath = resolve(infraDir, fileName);
    try {
      for (const line of readFileSync(envPath, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 1) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim().replaceAll(/^["']|["']$/g, "");
        if (key && !process.env[key]) process.env[key] = value;
      }
      break;
    } catch {
      // Try the next fallback file.
    }
  }
}

const EnvBooleanSchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().default("0.0.0.0"),
  TRUST_PROXY: z.string().default("loopback, linklocal, uniquelocal"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  JWT_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  ALLOW_PUBLIC_REGISTRATION: EnvBooleanSchema,
  S3_ENDPOINT: z.string().default("http://localhost:9000"),
  S3_PUBLIC_URL: z.string().optional(),
  S3_BUCKET: z.string().default("seclettr-attachments"),
  S3_ACCESS_KEY: z.string().default("minioadmin"),
  S3_SECRET_KEY: z.string().default("minioadmin"),
  S3_REGION: z.string().default("us-east-1"),
  TURN_SECRET: z.string().min(16).default("changeme-turn-secret"),
  TURN_DOMAIN: z.string().default("localhost"),
  TURN_PORT: z.coerce.number().int().min(1).max(65535).default(3478),
  TURNS_PORT: z.coerce.number().int().min(1).max(65535).default(5349),
  SFU_URL: z.string().default("http://localhost:3002"),
  APP_URL: z.string().default("http://localhost:5173"),
  COOKIE_SECURE: EnvBooleanSchema.default(true),
  MAX_ATTACHMENT_BYTES: z.coerce.number().int().default(100 * 1024 * 1024),
  MAX_MESSAGE_JSON_BYTES: z.coerce.number().int().min(64 * 1024).default(12 * 1024 * 1024),
  METRICS_BEARER_TOKEN: z.string().min(16).optional(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:dev@localhost"),

  // FCM (optional — overrides Android native WebSocket push when configured)
  FCM_SERVICE_ACCOUNT_PATH: z.string().optional(),
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),
  DELIVERED_MESSAGE_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  UNDELIVERED_MESSAGE_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  GROUP_MESSAGE_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  ENDED_CALL_SESSION_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
});

function normalizeEnv(inputEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inputEnv };
  if (!env["S3_ACCESS_KEY"] && env["MINIO_ACCESS_KEY"]) {
    env["S3_ACCESS_KEY"] = env["MINIO_ACCESS_KEY"];
  }
  if (!env["S3_SECRET_KEY"] && env["MINIO_SECRET_KEY"]) {
    env["S3_SECRET_KEY"] = env["MINIO_SECRET_KEY"];
  }
  return env;
}

function createConfigError(message: string): Error {
  const error = new Error(message);
  error.name = "InvalidConfigError";
  return error;
}

export function resolveConfig(inputEnv: NodeJS.ProcessEnv = process.env) {
  const result = ConfigSchema.safeParse(normalizeEnv(inputEnv));
  if (!result.success) {
    throw createConfigError(JSON.stringify(result.error.flatten()));
  }

  const data = result.data;
  const hasPublic = Boolean(data.VAPID_PUBLIC_KEY);
  const hasPrivate = Boolean(data.VAPID_PRIVATE_KEY);
  if (hasPublic !== hasPrivate) {
    throw createConfigError(
      "both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together"
    );
  }

  if (data.NODE_ENV === "production") {
    if (data.TURN_SECRET === "changeme-turn-secret") {
      throw createConfigError("TURN_SECRET must be overridden in production");
    }
    if (data.S3_ACCESS_KEY === "minioadmin" || data.S3_SECRET_KEY === "minioadmin") {
      throw createConfigError("default S3 credentials are not allowed in production");
    }
    if (!data.METRICS_BEARER_TOKEN) {
      throw createConfigError(
        "METRICS_BEARER_TOKEN must be set in production (minimum 16 characters)"
      );
    }
    // Guard against shipping the example JWT_SECRET from .env.example
    const KNOWN_WEAK_JWT_SECRETS = [
      "CHANGE_ME_JWT_SECRET_MIN_32_CHARS",
      "changeme",
      "secret",
      "your-secret-here",
      "01234567890123456789012345678901",
    ];
    if (KNOWN_WEAK_JWT_SECRETS.includes(data.JWT_SECRET)) {
      throw createConfigError(
        "JWT_SECRET must be changed from the default example value in production"
      );
    }
  }

  return data;
}

function loadConfig() {
  try {
    return resolveConfig(process.env);
  } catch (error) {
    console.error(
      "Invalid configuration:",
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  }
}

export const config = loadConfig();
export type Config = typeof config;
