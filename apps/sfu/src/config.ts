/**
 * SFU configuration — loaded once at startup.
 *
 * All environment variables are read here. The fallback env-file loader runs
 * only when JWT_SECRET is missing from the process environment (typically
 * during local development without Docker-injected vars).
 *
 * In production, env vars must be injected externally; the fallback loader
 * is not relied on and will only emit a warning if the file is absent.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

function loadFallbackEnvFile(): void {
  const envPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../infra/.env"
  );
  try {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 1) continue;
      const key = t.slice(0, eq).trim();
      const val = t
        .slice(eq + 1)
        .trim()
        .replaceAll(/^["']|["']$/g, "");
      if (key && !process.env[key]) process.env[key] = val;
    }
  } catch (err) {
    console.warn(
      "[sfu/config] Could not load fallback env file — expected in production if env is injected directly:",
      envPath,
      err
    );
  }
}

// Load fallback env file only in non-production when JWT_SECRET is not
// available in the environment. Production must inject env vars directly.
if (
  process.env["NODE_ENV"] !== "production" &&
  !process.env["JWT_SECRET"]
) {
  loadFallbackEnvFile();
}


function parseIntEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    console.error(`[sfu/config] Environment variable ${key} must be an integer, got: ${raw}`);
    process.exit(1);
  }
  return parsed;
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

const JWT_SECRET = process.env["JWT_SECRET"] ?? "";

if (JWT_SECRET.length < 32) {
  console.error("[sfu/config] JWT_SECRET must be set and at least 32 characters");
  process.exit(1);
}

// ── Topology guard ────────────────────────────────────────────────────────
// This SFU stores all room and peer state in the memory of a single process.
// Running more than one instance will cause split-brain: clients connected to
// different instances will not see each other's media streams.
//
// Supported topology:  SINGLE-NODE only.
// Unsupported topology: any horizontal scaling, load balancing, or failover
//                       without an external room-placement coordination layer.
//
// If your deployment orchestrator (Kubernetes, Docker Swarm, etc.) sets a
// replica count > 1, the SFU will refuse to start to prevent silent failures.
const REPLICA_COUNT = parseIntEnv("REPLICA_COUNT", 1);
if (REPLICA_COUNT > 1) {
  console.error(
    `[sfu/config] FATAL: REPLICA_COUNT=${REPLICA_COUNT}. ` +
    "This SFU only supports single-node deployment. " +
    "Multi-instance operation is NOT supported and will cause split-brain. " +
    "Unset REPLICA_COUNT or set it to 1."
  );
  process.exit(1);
}

export const config = {
  PORT: parseIntEnv("SFU_PORT", 3002),
  TRUST_PROXY:
    process.env["TRUST_PROXY"] ?? "loopback, linklocal, uniquelocal",
  ANNOUNCED_IP: process.env["ANNOUNCED_IP"] ?? "127.0.0.1",
  JWT_SECRET,
  API_INTERNAL_URL: stripTrailingSlashes(
    process.env["API_INTERNAL_URL"] ??
    `http://127.0.0.1:${process.env["API_HOST_PORT"] ?? "3001"}`
  ),
  MIN_PORT: parseIntEnv("RTC_MIN_PORT", 40000),
  MAX_PORT: parseIntEnv("RTC_MAX_PORT", 49999),
  ROOM_ACCESS_TIMEOUT_MS: 3000,
  RATE_LIMIT_WINDOW_MS: parseIntEnv("SFU_RATE_LIMIT_WINDOW_MS", 10_000),
  RATE_LIMIT_MAX_REQUESTS: parseIntEnv("SFU_RATE_LIMIT_MAX_REQUESTS", 120),
  PEER_TTL_MS: parseIntEnv("SFU_PEER_TTL_MS", 120_000),
  EMPTY_ROOM_TTL_MS: parseIntEnv("SFU_EMPTY_ROOM_TTL_MS", 30_000),
  CLEANUP_INTERVAL_MS: parseIntEnv("SFU_CLEANUP_INTERVAL_MS", 30_000),
  /** Upper bounds to prevent resource exhaustion (AUDIT.md H13). */
  MAX_ROOMS: parseIntEnv("SFU_MAX_ROOMS", 500),
  MAX_PEERS_PER_ROOM: parseIntEnv("SFU_MAX_PEERS_PER_ROOM", 50),
  MAX_TRANSPORTS_PER_PEER: parseIntEnv("SFU_MAX_TRANSPORTS_PER_PEER", 4),
  MAX_PRODUCERS_PER_PEER: parseIntEnv("SFU_MAX_PRODUCERS_PER_PEER", 6),
  MAX_CONSUMERS_PER_PEER: parseIntEnv("SFU_MAX_CONSUMERS_PER_PEER", 100),
  RATE_LIMIT_MAX_BUCKETS: parseIntEnv("SFU_RATE_LIMIT_MAX_BUCKETS", 100_000),
  /** Single-node topology. Informational — use REPLICA_COUNT guard above to enforce. */
  TOPOLOGY: "single-node" as const,
} as const;
