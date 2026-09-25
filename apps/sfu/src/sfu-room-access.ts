import type { FastifyReply, FastifyRequest } from "fastify";
import {
  safeParseVersionedWire,
  SfuRoomAccessResponseSchema,
  SFU_PROTOCOL_VERSION,
} from "@seclettr/protocol";

export interface SfuAuthPayload {
  sub: string;
  deviceId?: string;
  sessionId?: string;
  tokenUse?: string;
  iat?: number;
  exp?: number;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: SfuAuthPayload;
  }
}

function getAuthorizationHeader(request: FastifyRequest): string | null {
  const authHeader: unknown = request.headers.authorization;
  if (typeof authHeader === "string" && authHeader.trim().length > 0) {
    return authHeader;
  }
  if (Array.isArray(authHeader)) {
    const first = (authHeader as string[]).find((v) => v.trim().length > 0);
    return first ?? null;
  }
  return null;
}

export async function requireSfuAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    await request.jwtVerify();
    request.auth = request.user as SfuAuthPayload;
    if (request.auth.tokenUse !== "access" && request.auth.tokenUse !== "guest") {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  } catch {
    return reply.code(401).send({ error: "Unauthorized" });
  }
}

export interface RoomAccessCheckerDeps {
  apiInternalUrl: string;
  roomAccessTimeoutMs: number;
}

export interface RoomAccessChecker {
  ensureRoomAccess(
    request: FastifyRequest,
    reply: FastifyReply,
    roomId: string
  ): Promise<boolean>;
}

export function createRoomAccessChecker(
  deps: RoomAccessCheckerDeps
): RoomAccessChecker {
  async function ensureRoomAccess(
    request: FastifyRequest,
    reply: FastifyReply,
    roomId: string
  ): Promise<boolean> {
    const authorization = getAuthorizationHeader(request);
    if (!authorization) {
      await reply.code(401).send({ error: "Unauthorized" });
      return false;
    }

    let response: Response;
    try {
      response = await fetch(`${deps.apiInternalUrl}/calls/${roomId}/sfu-access`, {
        method: "GET",
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(deps.roomAccessTimeoutMs),
      });
    } catch (err) {
      request.log.warn({ err, roomId }, "SFU room access check failed");
      await reply.code(503).send({ error: "Room authorization unavailable" });
      return false;
    }

    if (response.status === 200) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        await reply
          .code(502)
          .send({ error: "Invalid room authorization response" });
        return false;
      }
      const parsed = safeParseVersionedWire(
        SfuRoomAccessResponseSchema,
        body,
        SFU_PROTOCOL_VERSION
      );
      if (!parsed.success) {
        await reply
          .code(502)
          .send({ error: "Invalid room authorization response" });
        return false;
      }
      return true;
    }

    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404
    ) {
      let errorMessage = "Forbidden";
      try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body.error === "string" && body.error.trim().length > 0) {
          errorMessage = body.error;
        }
      } catch { /* ignore parse errors */ }
      await reply.code(response.status).send({ error: errorMessage });
      return false;
    }

    await reply.code(502).send({ error: "Room authorization failed" });
    return false;
  }

  return { ensureRoomAccess };
}
