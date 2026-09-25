import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID, createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  ROOMS_PROTOCOL_VERSION,
  RoomCreateResponseSchema,
  RoomJoinPreviewResponseSchema,
  RoomJoinResponseSchema,
  RoomParticipantsResponseSchema,
} from "@seclettr/protocol";
import { requireAuth, requireGuestOrAuth } from "../../middleware/auth.js";
import { query, transaction } from "../../db/pool.js";
import { config } from "../../config.js";
import { consumeFixedWindowRateLimit } from "../../utils/fixed-window-rate-limit.js";
import {
  addGroupCallParticipant,
  removeGroupCallParticipant,
} from "../../services/group-call-presence.js";

const ROOM_RATE_LIMIT_WINDOW_SEC = 60;
const ROOM_RATE_LIMIT_MAX = 30;

const INVITE_TOKEN_LENGTH = 32;
/** Guest tokens are bounded by the room TTL but never exceed 2 hours. */
const GUEST_TOKEN_MAX_TTL_SECONDS = 2 * 60 * 60;

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const CreateRoomBodySchema = z.object({
  callType: z.enum(["audio", "video"]),
  expiresInMinutes: z.number().int().min(5).max(10080),
});

const JoinRoomBodySchema = z.object({
  guestName: z.string().min(1).max(64),
});

type ActiveRoom = {
  id: string;
  caller_user_id: string;
  call_type: "audio" | "video";
  status: string;
  is_room: boolean;
};

type RoomInvite = {
  id: string;
  call_session_id: string;
  expires_at: Date;
};

async function getActiveRoom(callId: string): Promise<ActiveRoom | null> {
  const rows = await query<ActiveRoom>(
    `SELECT id, caller_user_id, call_type, status, is_room
     FROM call_sessions
     WHERE id = $1 AND is_room = TRUE AND status IN ('ringing', 'active')`,
    [callId]
  );
  return rows[0] ?? null;
}

async function getActiveRoomInviteByToken(token: string): Promise<(RoomInvite & { call_type: "audio" | "video"; host_username: string; room_status: string }) | null> {
  const rows = await query<RoomInvite & { call_type: "audio" | "video"; host_username: string; room_status: string }>(
    `SELECT ri.id, ri.call_session_id, ri.expires_at,
            cs.call_type, u.username AS host_username, cs.status AS room_status
     FROM room_invites ri
     INNER JOIN call_sessions cs ON cs.id = ri.call_session_id
     INNER JOIN users u ON u.id = cs.caller_user_id
     WHERE ri.token_hash = $1
       AND ri.expires_at > now()
       AND cs.status IN ('ringing', 'active')
       AND cs.is_room = TRUE`,
    [hashInviteToken(token)]
  );
  return rows[0] ?? null;
}

async function enforceRoomRateLimit(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const limit = await consumeFixedWindowRateLimit({
    key: `rate:rooms-route:v1:${request.ip}`,
    max: ROOM_RATE_LIMIT_MAX,
    windowSec: ROOM_RATE_LIMIT_WINDOW_SEC,
  });
  if (limit.allowed) return;
  reply.header("Retry-After", String(limit.retryAfterSec));
  void reply.code(429).send({ error: "Too many room requests" });
}

function buildInviteUrl(token: string): string {
  const base = config.APP_URL.replace(/\/+$/, "");
  return `${base}/room/${token}`;
}

function resolveGuestTokenTtlSeconds(roomExpiresAt: Date): number {
  const secondsUntilExpiry = Math.floor((roomExpiresAt.getTime() - Date.now()) / 1000);
  return Math.min(Math.max(secondsUntilExpiry, 0), GUEST_TOKEN_MAX_TTL_SECONDS);
}

async function getActiveRoomParticipantCount(callId: string): Promise<number> {
  const rows = await query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM room_guest_sessions WHERE call_session_id = $1`,
    [callId]
  );
  return Number.parseInt(rows[0]?.cnt ?? "0", 10);
}

export async function roomRoutes(fastify: FastifyInstance): Promise<void> {
  const roomPreHandlers = [enforceRoomRateLimit];

  // POST /rooms — authenticated user creates a standalone room + invite link
  fastify.post<{ Body: unknown }>(
    "/",
    { preHandler: [enforceRoomRateLimit, requireAuth] },
    async (request, reply) => {
      const body = CreateRoomBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "Invalid request body", details: body.error.flatten() });
      }
      const { callType, expiresInMinutes } = body.data;
      const { sub: userId } = request.auth;

      const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);
      const inviteToken = nanoid(INVITE_TOKEN_LENGTH);

      const callId = await transaction(async (client) => {
        const callRows = await client.query<{ id: string }>(
          `INSERT INTO call_sessions (caller_user_id, call_type, status, is_room)
           VALUES ($1, $2, 'active', TRUE)
           RETURNING id`,
          [userId, callType]
        );
        const newCallId = callRows.rows[0]?.id;
        if (!newCallId) throw new Error("Failed to create room call session");

        await client.query(
          `INSERT INTO room_invites (call_session_id, token_hash, expires_at)
           VALUES ($1, $2, $3)`,
          [newCallId, hashInviteToken(inviteToken), expiresAt.toISOString()]
        );
        return newCallId;
      });

      return RoomCreateResponseSchema.parse({
        version: ROOMS_PROTOCOL_VERSION,
        callId,
        inviteToken,
        inviteUrl: buildInviteUrl(inviteToken),
        expiresAt: expiresAt.toISOString(),
      });
    }
  );

  // GET /rooms/join/:token — public, returns room preview (no auth required)
  fastify.get<{ Params: { token: string } }>(
    "/join/:token",
    { preHandler: roomPreHandlers },
    async (request, reply) => {
      const { token } = request.params;
      const invite = await getActiveRoomInviteByToken(token);
      if (!invite) {
        return reply.code(404).send({ error: "Invite not found or expired" });
      }

      const participantCount = await getActiveRoomParticipantCount(invite.call_session_id);

      return RoomJoinPreviewResponseSchema.parse({
        version: ROOMS_PROTOCOL_VERSION,
        callId: invite.call_session_id,
        callType: invite.call_type,
        hostUsername: invite.host_username,
        expiresAt: invite.expires_at.toISOString(),
        participantCount,
      });
    }
  );

  // POST /rooms/join/:token — public, creates guest session + issues guest JWT
  fastify.post<{ Params: { token: string }; Body: unknown }>(
    "/join/:token",
    { preHandler: roomPreHandlers },
    async (request, reply) => {
      const { token } = request.params;
      const body = JoinRoomBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "Invalid request body", details: body.error.flatten() });
      }
      const { guestName } = body.data;

      const invite = await getActiveRoomInviteByToken(token);
      if (!invite) {
        return reply.code(404).send({ error: "Invite not found or expired" });
      }

      const guestSessionId = randomUUID();

      await query(
        `INSERT INTO room_guest_sessions (id, call_session_id, guest_name)
         VALUES ($1, $2, $3)`,
        [guestSessionId, invite.call_session_id, guestName]
      );

      const ttlSeconds = resolveGuestTokenTtlSeconds(invite.expires_at);

      const guestToken = fastify.jwt.sign(
        {
          sub: guestSessionId,
          deviceId: guestSessionId,
          sessionId: guestSessionId,
          guestName,
          roomId: invite.call_session_id,
          tokenUse: "guest" as const,
        },
        { expiresIn: ttlSeconds }
      );

      return RoomJoinResponseSchema.parse({
        version: ROOMS_PROTOCOL_VERSION,
        callId: invite.call_session_id,
        callType: invite.call_type,
        guestToken,
        guestSessionId,
        sfuUrl: config.SFU_PUBLIC_URL,
        expiresAt: invite.expires_at.toISOString(),
      });
    }
  );

  // DELETE /rooms/:callId/guests/:guestSessionId — host kicks a guest
  fastify.delete<{ Params: { callId: string; guestSessionId: string } }>(
    "/:callId/guests/:guestSessionId",
    { preHandler: [enforceRoomRateLimit, requireAuth] },
    async (request, reply) => {
      const { callId, guestSessionId } = request.params;
      const { sub: userId } = request.auth;

      const room = await getActiveRoom(callId);
      if (!room) {
        return reply.code(404).send({ error: "Room not found" });
      }
      if (room.caller_user_id !== userId) {
        return reply.code(403).send({ error: "Only the room host can kick guests" });
      }

      await query(
        `DELETE FROM room_guest_sessions WHERE id = $1 AND call_session_id = $2`,
        [guestSessionId, callId]
      );

      return reply.code(204).send();
    }
  );

  // DELETE /rooms/:callId — host closes the room for everyone
  fastify.delete<{ Params: { callId: string } }>(
    "/:callId",
    { preHandler: [enforceRoomRateLimit, requireAuth] },
    async (request, reply) => {
      const { callId } = request.params;
      const { sub: userId } = request.auth;

      const room = await getActiveRoom(callId);
      if (!room) {
        return reply.code(404).send({ error: "Room not found" });
      }
      if (room.caller_user_id !== userId) {
        return reply.code(403).send({ error: "Only the room host can close the room" });
      }

      await query(
        `UPDATE call_sessions SET status = 'ended', ended_at = now() WHERE id = $1`,
        [callId]
      );

      return reply.code(204).send();
    }
  );

  // POST /rooms/:callId/participants — join room presence (guest or authenticated host)
  fastify.post<{ Params: { callId: string } }>(
    "/:callId/participants",
    { preHandler: [enforceRoomRateLimit, requireGuestOrAuth] },
    async (request, reply) => {
      const { callId } = request.params;
      const { sub: participantId, deviceId, tokenUse, roomId } = request.auth;

      if (tokenUse === "guest" && roomId !== callId) {
        return reply.code(403).send({ error: "Guest token is for a different room" });
      }

      const room = await getActiveRoom(callId);
      if (!room) {
        return reply.code(404).send({ error: "Room not found" });
      }

      await addGroupCallParticipant(callId, participantId, deviceId);
      return reply.code(204).send();
    }
  );

  // DELETE /rooms/:callId/participants/me — leave room presence
  fastify.delete<{ Params: { callId: string } }>(
    "/:callId/participants/me",
    { preHandler: [enforceRoomRateLimit, requireGuestOrAuth] },
    async (request, reply) => {
      const { callId } = request.params;
      const { sub: participantId, deviceId } = request.auth;

      await removeGroupCallParticipant(callId, participantId, deviceId);
      return reply.code(204).send();
    }
  );

  // GET /rooms/:callId/participants — list participants (guest or host)
  fastify.get<{ Params: { callId: string } }>(
    "/:callId/participants",
    { preHandler: [enforceRoomRateLimit, requireGuestOrAuth] },
    async (request, reply) => {
      const { callId } = request.params;
      const { tokenUse, roomId } = request.auth;

      if (tokenUse === "guest" && roomId !== callId) {
        return reply.code(403).send({ error: "Guest token is for a different room" });
      }

      const room = await getActiveRoom(callId);
      if (!room) {
        return reply.code(404).send({ error: "Room not found" });
      }

      // Fetch host info
      const hostRows = await query<{ id: string; username: string }>(
        `SELECT id, username FROM users WHERE id = $1`,
        [room.caller_user_id]
      );
      const hostUser = hostRows[0];

      // Fetch guest sessions
      const guestRows = await query<{ id: string; guest_name: string }>(
        `SELECT id, guest_name FROM room_guest_sessions WHERE call_session_id = $1 ORDER BY created_at`,
        [callId]
      );

      const participants = [
        ...(hostUser ? [{ id: hostUser.id, displayName: hostUser.username, isGuest: false }] : []),
        ...guestRows.map((g) => ({ id: g.id, displayName: g.guest_name, isGuest: true })),
      ];

      return RoomParticipantsResponseSchema.parse({
        version: ROOMS_PROTOCOL_VERSION,
        participants,
      });
    }
  );

  // GET /rooms/:callId/sfu-access — validates guest or host can access SFU room
  // Note: also extended on /calls/:callId/sfu-access for rooms, but this is used by room-specific clients
  fastify.get<{ Params: { callId: string } }>(
    "/:callId/sfu-access",
    { preHandler: [enforceRoomRateLimit, requireGuestOrAuth] },
    async (request, reply) => {
      const { callId } = request.params;
      const { sub: userId, tokenUse, roomId } = request.auth;

      const room = await getActiveRoom(callId);
      if (!room) {
        return reply.code(404).send({ error: "Room not found" });
      }

      if (tokenUse === "guest") {
        if (roomId !== callId) {
          return reply.code(403).send({ error: "Forbidden" });
        }
        // Kicked guests have their session row removed; deny re-entry.
        const guestSession = await query<{ id: string }>(
          `SELECT id FROM room_guest_sessions WHERE id = $1 AND call_session_id = $2`,
          [userId, callId]
        );
        if (guestSession.length === 0) {
          return reply.code(403).send({ error: "Forbidden" });
        }
        return { ok: true };
      }

      // Authenticated user: must be the host
      if (room.caller_user_id !== userId) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      return { ok: true };
    }
  );
}
