/**
 * Access-token session liveness.
 *
 * Access tokens are stateless JWTs. Historically nothing re-checked
 * `auth_sessions`, so a token stayed valid (and could open a new WebSocket)
 * until its 15-minute expiry even after logout or device revocation
 * (AUDIT.md H4).
 *
 * `isAuthSessionActive` is the authoritative check. A short-lived positive
 * cache in Redis keeps the per-request cost bounded; logout and device
 * revocation invalidate it explicitly. Cache failures fall through to the
 * database so a Redis outage does not become an auth outage, while a database
 * failure propagates to the caller (fail-closed).
 */
import { query } from "../db/pool.js";
import { redis } from "./redis.js";

const SESSION_ACTIVE_CACHE_PREFIX = "auth:session-active:";
const SESSION_ACTIVE_CACHE_TTL_SECONDS = 30;

function cacheKey(sessionId: string): string {
  return `${SESSION_ACTIVE_CACHE_PREFIX}${sessionId}`;
}

export async function isAuthSessionActive(sessionId: string): Promise<boolean> {
  if (!sessionId) return false;

  try {
    const cached = await redis.get(cacheKey(sessionId));
    if (cached === "1") return true;
  } catch {
    // Cache unavailable — fall through to the authoritative database check.
  }

  const rows = await query<{ id: string }>(
    `SELECT id FROM auth_sessions
      WHERE id = $1 AND expires_at > now()
      LIMIT 1`,
    [sessionId]
  );
  const active = rows.length === 1;

  if (active) {
    try {
      await redis.setex(cacheKey(sessionId), SESSION_ACTIVE_CACHE_TTL_SECONDS, "1");
    } catch {
      // Best-effort caching only.
    }
  }

  return active;
}

export async function invalidateAuthSessionCache(sessionId: string): Promise<void> {
  if (!sessionId) return;
  try {
    await redis.del(cacheKey(sessionId));
  } catch {
    // Best-effort invalidation; the cache TTL bounds the window regardless.
  }
}

export async function invalidateAuthSessionCacheMany(
  sessionIds: string[]
): Promise<void> {
  await Promise.all(sessionIds.map((sessionId) => invalidateAuthSessionCache(sessionId)));
}
