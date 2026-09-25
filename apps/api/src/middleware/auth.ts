import { createHash } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { query } from "../db/pool.js";
import { isAuthSessionActive } from "../services/auth-session.js";

export interface AuthPayload {
  sub: string;        // userId (or guestSessionId for guests)
  deviceId: string;
  sessionId: string;
  tokenUse?: "access" | "ws" | "contact" | "guest";
  // Guest-only fields:
  guestName?: string;
  roomId?: string;
  iat: number;
  exp: number;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthPayload;
  }
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    await request.jwtVerify();
    const payload = request.user as AuthPayload;
    // Only access tokens are valid for HTTP API routes.
    if (payload.tokenUse !== "access") {
      await reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    // A stateless access token must still map to a live session, otherwise
    // logout/device revocation would not take effect until token expiry (H4).
    if (!(await isAuthSessionActive(payload.sessionId))) {
      await reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    (request as FastifyRequest & { auth: AuthPayload }).auth = payload;
  } catch {
    await reply.code(401).send({ error: "Unauthorized" });
  }
}

/**
 * Accepts a background poll token (Authorization: Bearer <token>) and populates
 * request.auth with the user/device pair bound to that token.
 */
export async function requireBackgroundToken(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token) {
    await reply.code(401).send({ error: "Unauthorized" });
    return;
  }
  const hash = createHash("sha256").update(token).digest("hex");
  const rows = await query<{ user_id: string; device_id: string }>(
    `SELECT bpt.user_id, bpt.device_id
     FROM background_poll_tokens bpt
     INNER JOIN devices d ON d.id = bpt.device_id AND d.user_id = bpt.user_id
     WHERE bpt.token_hash = $1
       AND bpt.expires_at > now()
     LIMIT 1`,
    [hash]
  );
  if (rows.length === 0) {
    await reply.code(401).send({ error: "Unauthorized" });
    return;
  }
  (request as FastifyRequest & { auth: AuthPayload }).auth = {
    sub: rows[0]!.user_id,
    deviceId: rows[0]!.device_id,
    sessionId: "",
    tokenUse: "access",
    iat: 0,
    exp: 0,
  };
}

export async function requireAuthOrBackgroundToken(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const header = request.headers.authorization;
  // If the header looks like a background token (not a JWT), use background path.
  // JWTs have three dot-separated base64 parts; background tokens are nanoid(64).
  const looksLikeJwt = header?.startsWith("Bearer ") && header.split(".").length === 3;
  if (looksLikeJwt) {
    return requireAuth(request, reply);
  }
  return requireBackgroundToken(request, reply);
}

export async function requireGuestOrAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    await request.jwtVerify();
    const payload = request.user as AuthPayload;
    if (payload.tokenUse !== "access" && payload.tokenUse !== "guest") {
      await reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    // Authenticated access tokens must map to a live session; guest tokens are
    // validated against room_guest_sessions by the route instead (H4).
    if (
      payload.tokenUse === "access" &&
      !(await isAuthSessionActive(payload.sessionId))
    ) {
      await reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    (request as FastifyRequest & { auth: AuthPayload }).auth = payload;
  } catch {
    await reply.code(401).send({ error: "Unauthorized" });
  }
}
