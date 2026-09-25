import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import argon2 from "argon2";
import { nanoid } from "nanoid";
import { query, transaction } from "../../db/pool.js";
import { config } from "../../config.js";
import { requireAuth } from "../../middleware/auth.js";
import { consumeFixedWindowRateLimit } from "../../utils/fixed-window-rate-limit.js";
import { parseVersionedOrReply } from "../../utils/validation.js";
import { buildRefreshToken, parseRefreshToken } from "../../utils/refresh-token.js";
import { recordAuthEvent } from "../../services/observability.js";
import { publishForceDisconnect } from "../../services/redis.js";
import { invalidateAuthSessionCache } from "../../services/auth-session.js";
import { appendAuditEvent } from "../../services/audit-log.js";
import {
  AUTH_PROTOCOL_VERSION,
  LoginResponseSchema,
  RefreshResponseSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  LoginRequestSchema,
} from "@seclettr/protocol";

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
} as const satisfies argon2.Options & { raw?: false };

const AUTH_ROUTE_RATE_LIMIT_WINDOW_SEC = 5 * 60;
const REFRESH_RATE_LIMIT_WINDOW_SEC = 5 * 60;
const WS_TICKET_TTL_SECONDS = 60;
const BACKGROUND_POLL_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const WS_TICKET_RATE_LIMIT_WINDOW_SEC = 60;
const AUTH_ROUTE_RATE_LIMIT_MAX = (() => {
  const override = process.env["QM_API_TEST_AUTH_RATE_LIMIT_MAX"];
  if (!override) return 20;
  const parsed = Number.parseInt(override, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
})();
const REFRESH_RATE_LIMIT_MAX = (() => {
  const override = process.env["QM_API_TEST_REFRESH_RATE_LIMIT_MAX"];
  if (!override) return 120;
  const parsed = Number.parseInt(override, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120;
})();
const WS_TICKET_RATE_LIMIT_MAX = (() => {
  const override = process.env["QM_API_TEST_WS_TICKET_RATE_LIMIT_MAX"];
  if (!override) return 120;
  const parsed = Number.parseInt(override, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120;
})();

interface RefreshSessionRow {
  id: string;
  user_id: string;
  device_id: string;
  refresh_token_hash: string;
  expires_at: Date;
  username: string;
}

type RefreshSessionResolution =
  | { ok: true; session: RefreshSessionRow }
  | { ok: false; error: string; clearCookie: boolean };

async function enforceAuthRouteRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const limit = await consumeFixedWindowRateLimit({
    key: `rate:auth-route:v1:${request.ip}`,
    max: AUTH_ROUTE_RATE_LIMIT_MAX,
    windowSec: AUTH_ROUTE_RATE_LIMIT_WINDOW_SEC,
  });

  if (limit.allowed) return;

  reply.header("Retry-After", String(limit.retryAfterSec));
  void reply.code(429).send({ error: "Too many auth requests" });
}

async function enforceRefreshRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const limit = await consumeFixedWindowRateLimit({
    key: `rate:auth-refresh:v1:${request.ip}`,
    max: REFRESH_RATE_LIMIT_MAX,
    windowSec: REFRESH_RATE_LIMIT_WINDOW_SEC,
  });

  if (limit.allowed) return;

  reply.header("Retry-After", String(limit.retryAfterSec));
  void reply.code(429).send({ error: "Too many refresh requests" });
}

async function enforceWsTicketRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = (request as FastifyRequest & { auth?: { sessionId?: string; sub?: string; deviceId?: string } }).auth;
  const subjectKey = auth?.sessionId ?? `${auth?.sub ?? "unknown"}:${auth?.deviceId ?? "unknown"}`;
  const limit = await consumeFixedWindowRateLimit({
    key: `rate:ws-ticket:v1:${subjectKey}`,
    max: WS_TICKET_RATE_LIMIT_MAX,
    windowSec: WS_TICKET_RATE_LIMIT_WINDOW_SEC,
  });

  if (limit.allowed) return;

  reply.header("Retry-After", String(limit.retryAfterSec));
  void reply.code(429).send({ error: "Too many websocket auth requests" });
}

async function resolveRefreshSession(
  request: FastifyRequest
): Promise<RefreshSessionResolution> {
  // For native clients (Capacitor) the `X-Refresh-Token` header is the primary
  // carrier.  Capacitor Preferences survives Android process kills while the
  // WebView cookie store can be wiped, so the client always sends the latest
  // persisted token as a header.  The cookie is kept as a fallback for the
  // transition window (e.g. first launch before Preferences is populated).
  // For regular browser sessions the HttpOnly cookie is the only carrier.
  // The header path is restricted to known native origins to prevent misuse.
  const cookieToken = request.cookies["refresh_token"];
  const headerToken = isNativeClient(request)
    ? (request.headers["x-refresh-token"] as string | undefined)
    : undefined;
  const rawToken = isNativeClient(request)
    ? (headerToken ?? cookieToken)
    : cookieToken;

  if (!rawToken) {
    return { ok: false, error: "No refresh token", clearCookie: false };
  }

  const parsedRefresh = parseRefreshToken(rawToken);
  if (!parsedRefresh) {
    return {
      ok: false,
      error: "Invalid refresh token format",
      clearCookie: true,
    };
  }

  const sessions = await query<RefreshSessionRow>(
    `SELECT
       s.id,
       s.user_id,
       s.device_id,
       s.refresh_token_hash,
       s.expires_at,
       u.username
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now()
     LIMIT 1`,
    [parsedRefresh.sessionId]
  );

  if (sessions.length !== 1) {
    return {
      ok: false,
      error: "Invalid or expired refresh token",
      clearCookie: true,
    };
  }

  const session = sessions[0]!;
  const valid = await argon2.verify(
    session.refresh_token_hash,
    parsedRefresh.secret
  ).catch(() => false);

  if (!valid) {
    return {
      ok: false,
      error: "Invalid or expired refresh token",
      clearCookie: true,
    };
  }

  return { ok: true, session };
}

function sendRefreshSessionError(
  reply: FastifyReply,
  resolution: Extract<RefreshSessionResolution, { ok: false }>
) {
  if (resolution.clearCookie) {
    reply.clearCookie("refresh_token", { path: "/" });
  }
  return reply.code(401).send({ error: resolution.error });
}

/**
 * Returns true for Capacitor / Ionic WebView origins (Android: `https://localhost`,
 * iOS: `capacitor://localhost`).  Used to:
 *   1. Set `SameSite=None` on the refresh cookie so it round-trips cross-origin.
 *   2. Return the refresh token in the response body so the client can persist it
 *      to native Preferences and survive Android process-kill cookie loss.
 *   3. Accept an `X-Refresh-Token` header as a fallback when the WebView cookie
 *      store has been wiped (e.g. after OS-level process kill on Android).
 */
function isNativeClient(request: FastifyRequest): boolean {
  if (config.NODE_ENV === "development") return true;
  const originHeader = request.headers["origin"];
  const clientOriginHeader = request.headers["x-client-origin"];
  const origin = typeof originHeader === "string"
    ? originHeader
    : Array.isArray(originHeader)
      ? (originHeader[0] ?? "")
      : "";
  const clientOrigin = typeof clientOriginHeader === "string"
    ? clientOriginHeader
    : Array.isArray(clientOriginHeader)
      ? (clientOriginHeader[0] ?? "")
      : "";
  return (
    origin === "https://localhost" ||
    origin === "capacitor://localhost" ||
    origin === "ionic://localhost" ||
    clientOrigin === "https://localhost" ||
    clientOrigin === "capacitor://localhost" ||
    clientOrigin === "ionic://localhost"
  );
}

/**
 * Capacitor Android uses `https://localhost` as its WebView origin;
 * Capacitor iOS uses `capacitor://localhost`.  Both are cross-site relative
 * to the server domain, so `SameSite=Strict` blocks the refresh-token cookie
 * from being sent on subsequent requests.  Detect these origins and use
 * `SameSite=None` (always Secure) so the cookie round-trips correctly.
 * For regular browser sessions keep `SameSite=Strict` for CSRF hardening.
 */
function resolveRefreshCookieSameSite(
  request: FastifyRequest
): "strict" | "none" {
  return isNativeClient(request) ? "none" : "strict";
}

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/register", { preHandler: enforceAuthRouteRateLimit }, async (request, reply) => {
    const body = parseVersionedOrReply(
      reply,
      RegisterRequestSchema,
      request.body,
      AUTH_PROTOCOL_VERSION
    );
    if (!body) return;
    if (!config.ALLOW_PUBLIC_REGISTRATION) {
      return reply.code(403).send({ error: "Registration is disabled by administrator" });
    }

    const passwordHash = await argon2.hash(body.password, ARGON2_OPTIONS);

    const result = await transaction(async (client) => {
      const existing = await client.query(
        "SELECT id FROM users WHERE username = $1",
        [body.username]
      );
      if ((existing.rowCount ?? 0) > 0) {
        return { conflict: true as const };
      }

      const userRows = await client.query<{ id: string }>(
        "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id",
        [body.username, passwordHash]
      );
      const userId = userRows.rows[0]!.id;

      const deviceRows = await client.query<{ id: string }>(
        `INSERT INTO devices
           (user_id, name, identity_key_public, signing_key_public, registration_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          userId,
          body.device.name,
          body.device.identityKeyPublic,
          body.device.signingKeyPublic,
          body.device.registrationId,
        ]
      );
      const deviceId = deviceRows.rows[0]!.id;

      await client.query(
        "DELETE FROM one_time_prekeys WHERE device_id = $1 AND used_at IS NULL",
        [deviceId]
      );
      await client.query("DELETE FROM signed_prekeys WHERE device_id = $1", [deviceId]);

      await client.query(
        `INSERT INTO signed_prekeys (device_id, key_id, public_key, signature)
         VALUES ($1, $2, $3, $4)`,
        [
          deviceId,
          body.device.signedPreKey.id,
          body.device.signedPreKey.publicKey,
          body.device.signedPreKey.signature,
        ]
      );

      if (body.device.oneTimePreKeys.length > 0) {
        const otkValues = body.device.oneTimePreKeys
          .map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`)
          .join(", ");
        const otkParams: unknown[] = [deviceId];
        for (const otk of body.device.oneTimePreKeys) {
          otkParams.push(otk.id, otk.publicKey);
        }
        await client.query(
          `INSERT INTO one_time_prekeys (device_id, key_id, public_key) VALUES ${otkValues}`,
          otkParams
        );
      }

      const refreshTokenSecret = nanoid(64);
      const tokenHash = await argon2.hash(refreshTokenSecret, ARGON2_OPTIONS);
      const expiresAt = new Date(
        Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000
      );

      const sessionRows = await client.query<{ id: string }>(
        `INSERT INTO auth_sessions
           (user_id, device_id, refresh_token_hash, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [userId, deviceId, tokenHash, expiresAt]
      );
      const sessionId = sessionRows.rows[0]!.id;
      const refreshToken = buildRefreshToken(sessionId, refreshTokenSecret);

      const accessToken = fastify.jwt.sign({
        sub: userId,
        deviceId,
        sessionId,
        tokenUse: "access" as const,
      });

      return { conflict: false as const, userId, deviceId, accessToken, refreshToken };
    });

    if (result.conflict) {
      return reply.code(409).send({ error: "Username already taken" });
    }

    reply.setCookie("refresh_token", result.refreshToken, {
      httpOnly: true,
      sameSite: resolveRefreshCookieSameSite(request),
      secure: config.NODE_ENV === "development" ? true : config.COOKIE_SECURE,
      path: "/",
      maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86400,
    });

    recordAuthEvent("register");
    void appendAuditEvent({
      eventType: "auth.register",
      actorUserId: result.userId,
      actorDeviceId: result.deviceId,
      ipAddress: request.ip,
    });
    return reply.code(201).send(RegisterResponseSchema.parse({
      version: AUTH_PROTOCOL_VERSION,
      userId: result.userId,
      deviceId: result.deviceId,
      accessToken: result.accessToken,
      // Native clients need the token in the body to persist it to Preferences.
      ...(isNativeClient(request) ? { refreshToken: result.refreshToken } : {}),
    }));
  });

  fastify.post("/login", { preHandler: enforceAuthRouteRateLimit }, async (request, reply) => {
    const body = parseVersionedOrReply(
      reply,
      LoginRequestSchema,
      request.body,
      AUTH_PROTOCOL_VERSION
    );
    if (!body) return;

    const users = await query<{ id: string; password_hash: string; username: string }>(
      "SELECT id, password_hash, username FROM users WHERE username = $1",
      [body.username]
    );
    if (users.length === 0) {
      await argon2.hash("dummy-password", ARGON2_OPTIONS);
      recordAuthEvent("failure");
      void appendAuditEvent({
        eventType: "auth.login_failed",
        ipAddress: request.ip,
        metadata: { username: body.username, reason: "user_not_found" },
      });
      return reply.code(401).send({ error: "Invalid credentials" });
    }
    const user = users[0]!;

    const valid = await argon2.verify(user.password_hash, body.password);
    if (!valid) {
      recordAuthEvent("failure");
      void appendAuditEvent({
        eventType: "auth.login_failed",
        actorUserId: user.id,
        ipAddress: request.ip,
        metadata: { reason: "wrong_password" },
      });
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const result = await transaction(async (client) => {
      const existingDeviceRows = await client.query<{
        id: string;
        identity_key_public: string;
        signing_key_public: string;
      }>(
        `SELECT id, identity_key_public, signing_key_public
         FROM devices
         WHERE user_id = $1 AND registration_id = $2
         LIMIT 1`,
        [user.id, body.device.registrationId]
      );

      let deviceId: string;
      if ((existingDeviceRows.rowCount ?? 0) > 0) {
        const existingDevice = existingDeviceRows.rows[0]!;
        const identityChanged = existingDevice.identity_key_public !== body.device.identityKeyPublic;
        const signingChanged = existingDevice.signing_key_public !== body.device.signingKeyPublic;

        if (identityChanged || signingChanged) {
          return {
            deviceIdentityMismatch: true as const,
          };
        }

        await client.query(
          `UPDATE devices
           SET name = $1,
               last_seen_at = now()
           WHERE id = $2`,
          [body.device.name, existingDevice.id]
        );
        deviceId = existingDevice.id;
      } else {
        const deviceRows = await client.query<{ id: string }>(
          `INSERT INTO devices
             (user_id, name, identity_key_public, signing_key_public, registration_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [
            user.id,
            body.device.name,
            body.device.identityKeyPublic,
            body.device.signingKeyPublic,
            body.device.registrationId,
          ]
        );
        deviceId = deviceRows.rows[0]!.id;
      }

      await client.query(
        "DELETE FROM one_time_prekeys WHERE device_id = $1 AND used_at IS NULL",
        [deviceId]
      );
      await client.query("DELETE FROM signed_prekeys WHERE device_id = $1", [deviceId]);

      await client.query(
        `INSERT INTO signed_prekeys (device_id, key_id, public_key, signature)
         VALUES ($1, $2, $3, $4)`,
        [
          deviceId,
          body.device.signedPreKey.id,
          body.device.signedPreKey.publicKey,
          body.device.signedPreKey.signature,
        ]
      );

      if (body.device.oneTimePreKeys.length > 0) {
        const keyIds = body.device.oneTimePreKeys.map((otk) => otk.id);
        const publicKeys = body.device.oneTimePreKeys.map((otk) => otk.publicKey);
        await client.query(
          `INSERT INTO one_time_prekeys (device_id, key_id, public_key)
           SELECT $1, unnest($2::integer[]), unnest($3::text[])
           ON CONFLICT (device_id, key_id)
           DO UPDATE SET
             public_key = EXCLUDED.public_key,
             used_at = NULL,
             reserved_at = NULL,
             reservation_expires_at = NULL,
             reservation_token_hash = NULL,
             reserved_for_user_id = NULL,
             reserved_message_id = NULL,
             created_at = now()`,
          [deviceId, keyIds, publicKeys]
        );
      }

      const refreshTokenSecret = nanoid(64);
      const tokenHash = await argon2.hash(refreshTokenSecret, ARGON2_OPTIONS);
      const expiresAt = new Date(
        Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000
      );

      const sessionRows = await client.query<{ id: string }>(
        `INSERT INTO auth_sessions
           (user_id, device_id, refresh_token_hash, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [user.id, deviceId, tokenHash, expiresAt]
      );
      const sessionId = sessionRows.rows[0]!.id;
      const refreshToken = buildRefreshToken(sessionId, refreshTokenSecret);

      const accessToken = fastify.jwt.sign({
        sub: user.id,
        deviceId,
        sessionId,
        tokenUse: "access" as const,
      });

      return { userId: user.id, deviceId, accessToken, refreshToken, user: { username: user.username } };
    });

    if ("deviceIdentityMismatch" in result) {
      return reply.code(409).send({
        error: "Stored device identity does not match this registration. Reset local device data and sign in again to provision a new device.",
      });
    }

    reply.setCookie("refresh_token", result.refreshToken, {
      httpOnly: true,
      sameSite: resolveRefreshCookieSameSite(request),
      secure: config.NODE_ENV === "development" ? true : config.COOKIE_SECURE,
      path: "/",
      maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86400,
    });

    recordAuthEvent("login");
    void appendAuditEvent({
      eventType: "auth.login",
      actorUserId: result.userId,
      actorDeviceId: result.deviceId,
      ipAddress: request.ip,
    });
    return LoginResponseSchema.parse({
      version: AUTH_PROTOCOL_VERSION,
      userId: result.userId,
      deviceId: result.deviceId,
      accessToken: result.accessToken,
      user: result.user,
      // Native clients need the token in the body to persist it to Preferences.
      ...(isNativeClient(request) ? { refreshToken: result.refreshToken } : {}),
    });
  });

  fastify.post("/session", { preHandler: enforceRefreshRateLimit }, async (request, reply) => {
    const resolved = await resolveRefreshSession(request);
    if (!resolved.ok) {
      return sendRefreshSessionError(reply, resolved);
    }

    return {
      version: AUTH_PROTOCOL_VERSION,
      userId: resolved.session.user_id,
      deviceId: resolved.session.device_id,
      user: {
        username: resolved.session.username,
      },
    };
  });

  fastify.post("/refresh", { preHandler: enforceRefreshRateLimit }, async (request, reply) => {
    const resolved = await resolveRefreshSession(request);
    if (!resolved.ok) {
      return sendRefreshSessionError(reply, resolved);
    }

    const matchedSession = resolved.session;

    const newRefreshSecret = nanoid(64);
    const newHash = await argon2.hash(newRefreshSecret, ARGON2_OPTIONS);
    await query(
      `UPDATE auth_sessions
       SET refresh_token_hash = $1, last_used_at = now()
       WHERE id = $2`,
      [newHash, matchedSession.id]
    );
    const newRefreshToken = buildRefreshToken(matchedSession.id, newRefreshSecret);

    const accessToken = fastify.jwt.sign({
      sub: matchedSession.user_id,
      deviceId: matchedSession.device_id,
      sessionId: matchedSession.id,
      tokenUse: "access" as const,
    });

    reply.setCookie("refresh_token", newRefreshToken, {
      httpOnly: true,
      sameSite: resolveRefreshCookieSameSite(request),
      secure: config.NODE_ENV === "development" ? true : config.COOKIE_SECURE,
      path: "/",
      maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86400,
    });

    return RefreshResponseSchema.parse({
      version: AUTH_PROTOCOL_VERSION,
      accessToken,
      // Return the rotated token in the body for native clients so they can
      // keep Preferences in sync (the cookie is rotated but may not survive restart).
      ...(isNativeClient(request) ? { refreshToken: newRefreshToken } : {}),
    });
  });

  fastify.post("/ws-ticket", { preHandler: [requireAuth, enforceWsTicketRateLimit] }, async (request) => {
    const wsToken = fastify.jwt.sign(
      {
        sub: request.auth.sub,
        deviceId: request.auth.deviceId,
        sessionId: request.auth.sessionId,
        tokenUse: "ws" as const,
      },
      { expiresIn: `${WS_TICKET_TTL_SECONDS}s` }
    );
    return {
      wsToken,
      expiresInSec: WS_TICKET_TTL_SECONDS,
    };
  });

  fastify.post("/logout", { preHandler: enforceAuthRouteRateLimit }, async (request, reply) => {
    const headerToken = isNativeClient(request)
      ? (request.headers["x-refresh-token"] as string | undefined)
      : undefined;
    const rawToken = isNativeClient(request)
      ? (headerToken ?? request.cookies["refresh_token"])
      : request.cookies["refresh_token"];
    if (rawToken) {
      const parsedRefresh = parseRefreshToken(rawToken);
      if (parsedRefresh) {
        const sessions = await query<{ id: string; device_id: string; refresh_token_hash: string }>(
          "SELECT id, device_id, refresh_token_hash FROM auth_sessions WHERE id = $1 LIMIT 1",
          [parsedRefresh.sessionId]
        );
        if (sessions.length === 1) {
          const valid = await argon2.verify(
            sessions[0]!.refresh_token_hash,
            parsedRefresh.secret
          ).catch(() => false);
          if (valid) {
            await query("DELETE FROM auth_sessions WHERE id = $1", [parsedRefresh.sessionId]);
            await invalidateAuthSessionCache(parsedRefresh.sessionId);
            await query(
              "DELETE FROM background_poll_tokens WHERE device_id = $1",
              [sessions[0]!.device_id]
            );
            // Force-close any open WebSocket connections for this device.
            await publishForceDisconnect(sessions[0]!.device_id).catch(() => undefined);
          }
        }
      }
    }
    reply.clearCookie("refresh_token", { path: "/" });
    recordAuthEvent("logout");
    void appendAuditEvent({
      eventType: "auth.logout",
      ipAddress: request.ip,
    });
    return { ok: true };
  });

  fastify.post("/background-token", { preHandler: requireAuth }, async (request, reply) => {
    const { sub: userId, deviceId } = request.auth;
    const token = nanoid(64);
    const hash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + BACKGROUND_POLL_TOKEN_TTL_SECONDS * 1000);
    await query(
      `INSERT INTO background_poll_tokens (user_id, device_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, device_id)
       DO UPDATE SET
         token_hash = EXCLUDED.token_hash,
         expires_at = EXCLUDED.expires_at,
         created_at = now()`,
      [userId, deviceId, hash, expiresAt]
    );
    return reply.send({
      token,
      expiresAt: expiresAt.toISOString(),
      expiresInSec: BACKGROUND_POLL_TOKEN_TTL_SECONDS,
    });
  });
}
