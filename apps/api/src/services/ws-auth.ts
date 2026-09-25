/**
 * WebSocket token extraction and validation helpers.
 *
 * Decoupled from the main websocket.ts handler so this can be tested and
 * reasoned about independently.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { WS_AUTH_PROTOCOL_PREFIX } from "@seclettr/protocol";
import { config } from "../config.js";

export interface WsAuthResult {
  sub: string;
  deviceId: string;
  sessionId?: string;
  tokenUse?: "access" | "ws";
}

type WsTokenSource = "authorization" | "protocol";

interface ExtractedWsToken {
  token: string;
  source: WsTokenSource;
}

const LEGACY_WS_AUTH_PROTOCOL_PREFIX = "qm.auth.";
const ALLOW_LEGACY_PROTOCOL_ACCESS_TOKENS = config.NODE_ENV === "development";

/**
 * Extract a JWT token from the WebSocket upgrade request.
 *
 * Checks, in order:
 *  1. Authorization header (Bearer scheme)
 *  2. Sec-WebSocket-Protocol header (WS auth prefix scheme)
 *
 * Returns null if no token is found in either location.
 */
export function extractWebSocketToken(
  request: FastifyRequest
): ExtractedWsToken | null {
  const authHeader = request.headers.authorization;
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    return {
      token: authHeader.slice(7).trim(),
      source: "authorization",
    };
  }

  const protocolHeader = request.headers["sec-websocket-protocol"];
  const protocolsRaw = Array.isArray(protocolHeader)
    ? protocolHeader.join(",")
    : protocolHeader;
  if (!protocolsRaw) return null;

  for (const protocol of protocolsRaw.split(",")) {
    const trimmed = protocol.trim();
    if (trimmed.startsWith(WS_AUTH_PROTOCOL_PREFIX)) {
      const token = trimmed.slice(WS_AUTH_PROTOCOL_PREFIX.length);
      if (token) return { token, source: "protocol" };
    }
    if (trimmed.startsWith(LEGACY_WS_AUTH_PROTOCOL_PREFIX)) {
      const token = trimmed.slice(LEGACY_WS_AUTH_PROTOCOL_PREFIX.length);
      if (token) return { token, source: "protocol" };
    }
  }

  return null;
}

/**
 * Verify the JWT from a WS upgrade request and return the auth payload.
 *
 * Throws if:
 *  - No token found
 *  - JWT verification fails
 *  - The token is not ws-scoped or access-scoped. A `guest`/`contact` token
 *    (or a legacy token with no scope) must never open the realtime socket.
 *    Protocol-header tokens must additionally be ws-scoped, since the access
 *    token is reserved for the Authorization header path.
 */
export function verifyWebSocketToken(
  fastify: FastifyInstance,
  request: FastifyRequest
): WsAuthResult {
  const extracted = extractWebSocketToken(request);
  if (!extracted) throw new Error("No token");

  const payload = fastify.jwt.verify<WsAuthResult>(extracted.token);

  const isAccessLike =
    payload.tokenUse === "access" || payload.tokenUse === "ws";
  const isLegacyAllowed =
    ALLOW_LEGACY_PROTOCOL_ACCESS_TOKENS &&
    (payload.tokenUse === "access" || payload.tokenUse === undefined);

  if (!isAccessLike && !isLegacyAllowed) {
    throw new Error("WS token must be ws- or access-scoped");
  }

  if (
    extracted.source === "protocol" &&
    payload.tokenUse !== "ws" &&
    !isLegacyAllowed
  ) {
    throw new Error("WS protocol token must be ws-scoped");
  }

  return payload;
}
