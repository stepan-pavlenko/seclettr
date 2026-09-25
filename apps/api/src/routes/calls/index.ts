import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  GROUPS_PROTOCOL_VERSION,
  DirectMissedCallsResponseSchema,
  GroupActiveCallsResponseSchema,
  GroupCallJoinResponseSchema,
  GroupCallParticipantDevicesResponseSchema,
  GroupCallParticipantsResponseSchema,
  SFU_PROTOCOL_VERSION,
  SfuRoomAccessResponseSchema,
} from "@seclettr/protocol";
import { requireAuth, requireGuestOrAuth } from "../../middleware/auth.js";
import { query, transaction, type PoolClient } from "../../db/pool.js";
import { config } from "../../config.js";
import { consumeFixedWindowRateLimit } from "../../utils/fixed-window-rate-limit.js";
import { parseOrReply } from "../../utils/validation.js";
import { publishMessage, redis } from "../../services/redis.js";
import {
  createCallSessionStore,
  createDirectCallLifecycleManager,
} from "../../services/call-routing-state.js";
import { getPushPreferences, sendPushToUser } from "../../services/push.js";
import { buildCallInvitePushPayload, buildGroupCallStartedPushPayload, buildMissedCallPushPayload } from "../../services/push-payloads.js";
import { hasActiveConnectionForUserAcrossCluster } from "../../services/websocket.js";
import { recordCallEvent, recordPushNotificationFailure } from "../../services/observability.js";
import {
  addGroupCallParticipant,
  clearGroupCallParticipants,
  listGroupCallParticipantDevices,
  listGroupCallParticipantDeviceUsers,
  listGroupCallParticipants,
  refreshGroupCallParticipant,
  removeGroupCallParticipant,
} from "../../services/group-call-presence.js";
import {
  hasActiveGroupMembership,
  loadUserDeviceIds,
  publishGroupCallFanOut as publishGroupCallEvent,
  endGroupCallIfRosterEmpty,
} from "../../services/group-call-participant-routing.js";

const CreateCallBodySchema = z.object({
  calleeUserId: z.string().uuid().optional(),
  groupId: z.string().uuid().optional(),
  callType: z.enum(["audio", "video"]),
});

const UpdateCallStatusBodySchema = z.object({
  status: z.enum(["active", "ended", "missed", "rejected"]),
});

type CreateCallBody = z.infer<typeof CreateCallBodySchema>;
type UpdateCallStatusBody = z.infer<typeof UpdateCallStatusBodySchema>;

type ActiveCallSession = {
  id: string;
  caller_user_id: string;
  callee_user_id: string | null;
  group_id: string | null;
  call_type: "audio" | "video";
  status: "ringing" | "active" | "ended" | "missed" | "rejected";
  is_room: boolean;
};

type GroupCallParticipant = {
  userId: string;
  username: string;
};

type GroupCallParticipantDevice = {
  userId: string;
  deviceId: string;
};

type GroupCallReservation = {
  callId: string;
  callerUserId: string;
  reused: boolean;
};

type CreateCallResponse =
  | { callId: string }
  | { callId: string; created: boolean; callerUserId: string };

const CALL_ROUTE_RATE_LIMIT_WINDOW_SEC = 60;
const CALL_ROUTE_RATE_LIMIT_MAX = 90;

async function enforceCallRouteRateLimit(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const limit = await consumeFixedWindowRateLimit({
    key: `rate:calls-route:v1:${request.ip}`,
    max: CALL_ROUTE_RATE_LIMIT_MAX,
    windowSec: CALL_ROUTE_RATE_LIMIT_WINDOW_SEC,
  });

  if (limit.allowed) return;

  reply.header("Retry-After", String(limit.retryAfterSec));
  void reply.code(429).send({ error: "Too many call requests" });
}

async function groupExists(groupId: string): Promise<boolean> {
  const groups = await query<{ id: string }>(
    "SELECT id FROM groups WHERE id = $1",
    [groupId]
  );
  return groups.length > 0;
}

async function getActiveCallSession(
  callId: string
): Promise<ActiveCallSession | null> {
  const calls = await query<ActiveCallSession>(
    `SELECT id, caller_user_id, callee_user_id, group_id, call_type, status, is_room
     FROM call_sessions
     WHERE id = $1
       AND status IN ('ringing', 'active')`,
    [callId]
  );
  return calls[0] ?? null;
}

async function _getExistingActiveGroupCall(
  groupId: string
): Promise<ActiveCallSession | null> {
  const calls = await query<ActiveCallSession>(
    `SELECT id, caller_user_id, callee_user_id, group_id, call_type, status
     FROM call_sessions
     WHERE group_id = $1
       AND status IN ('ringing', 'active')
     ORDER BY
       CASE WHEN status = 'active' THEN 0 ELSE 1 END,
       COALESCE(answered_at, started_at) DESC,
       started_at DESC
     LIMIT 1`,
    [groupId]
  );
  return calls[0] ?? null;
}

async function getExistingActiveGroupCallForUpdate(
  client: PoolClient,
  groupId: string
): Promise<ActiveCallSession | null> {
  const result = await client.query<ActiveCallSession>(
    `SELECT id, caller_user_id, callee_user_id, group_id, call_type, status
     FROM call_sessions
     WHERE group_id = $1
       AND status IN ('ringing', 'active')
     ORDER BY
       CASE WHEN status = 'active' THEN 0 ELSE 1 END,
       COALESCE(answered_at, started_at) DESC,
       started_at DESC
     LIMIT 1`,
    [groupId]
  );
  return result.rows[0] ?? null;
}

async function notifyDirectCallCounterpartDevices(
  call: ActiveCallSession,
  actorUserId: string,
  messageType: "call.hangup" | "call.rejected"
): Promise<void> {
  if (!call.callee_user_id) return;

  const targetUserId =
    actorUserId === call.caller_user_id
      ? call.callee_user_id
      : call.caller_user_id;
  const targetDeviceIds = await loadUserDeviceIds(targetUserId);
  if (targetDeviceIds.length === 0) return;

  await Promise.all(
    [...new Set(targetDeviceIds)].map((targetDeviceId) =>
      publishMessage({
        type: messageType,
        callId: call.id,
        recipientDeviceId: targetDeviceId,
      })
    )
  );
}

async function resolveGroupCallParticipants(
  callId: string
): Promise<GroupCallParticipant[]> {
  const userIds = await listGroupCallParticipants(callId);
  if (userIds.length === 0) return [];

  const users = await query<{ id: string; username: string }>(
    `SELECT id, username
     FROM users
     WHERE id = ANY($1::uuid[])`,
    [userIds]
  );
  const byId = new Map(users.map((user) => [user.id, user.username]));
  return userIds
    .filter((userId) => byId.has(userId))
    .map((userId) => ({
      userId,
      username: byId.get(userId)!,
    }));
}

async function resolveGroupCallParticipantDevices(
  callId: string
): Promise<GroupCallParticipantDevice[]> {
  const activeDeviceUsers = await listGroupCallParticipantDeviceUsers(callId);
  if (activeDeviceUsers.length > 0) {
    return activeDeviceUsers.map(({ userId, deviceId }) => ({
      userId,
      deviceId,
    }));
  }

  const deviceIds = await listGroupCallParticipantDevices(callId);
  if (deviceIds.length === 0) return [];

  const activeUsers = new Set(await listGroupCallParticipants(callId));
  if (activeUsers.size === 0) return [];

  const devices = await query<{ id: string; user_id: string }>(
    `SELECT id, user_id
     FROM devices
     WHERE id = ANY($1::uuid[])`,
    [deviceIds]
  );

  return devices
    .filter((device) => activeUsers.has(device.user_id))
    .map((device) => ({
      userId: device.user_id,
      deviceId: device.id,
    }))
    .sort(
      (left, right) =>
        left.userId.localeCompare(right.userId) ||
        left.deviceId.localeCompare(right.deviceId)
    );
}

function canEndGroupCallForEveryone(
  currentCall: ActiveCallSession,
  userId: string
): boolean {
  return currentCall.caller_user_id === userId;
}

async function validateCreateCallTarget(
  reply: FastifyReply,
  userId: string,
  body: CreateCallBody
): Promise<boolean> {
  const { calleeUserId, groupId } = body;

  if (!calleeUserId && !groupId) {
    void reply.code(400).send({ error: "calleeUserId or groupId required" });
    return false;
  }

  if (calleeUserId && groupId) {
    void reply
      .code(400)
      .send({ error: "calleeUserId and groupId are mutually exclusive" });
    return false;
  }

  if (calleeUserId) {
    const targetUsers = await query<{ id: string }>(
      "SELECT id FROM users WHERE id = $1",
      [calleeUserId]
    );
    if (targetUsers.length === 0) {
      void reply.code(404).send({ error: "Callee not found" });
      return false;
    }
  }

  if (groupId && !(await validateGroupCallTarget(reply, groupId, userId))) {
    return false;
  }

  return true;
}

async function validateGroupCallTarget(
  reply: FastifyReply,
  groupId: string,
  userId: string
): Promise<boolean> {
  if (!(await groupExists(groupId))) {
    void reply.code(404).send({ error: "Group not found" });
    return false;
  }

  if (!(await hasActiveGroupMembership(groupId, userId))) {
    void reply.code(403).send({ error: "Not a group member" });
    return false;
  }

  return true;
}

async function reserveGroupCall(
  groupId: string,
  userId: string,
  callType: CreateCallBody["callType"]
): Promise<GroupCallReservation> {
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      groupId,
    ]);

    const existingGroupCall = await getExistingActiveGroupCallForUpdate(
      client,
      groupId
    );
    if (existingGroupCall) {
      return {
        callId: existingGroupCall.id,
        callerUserId: existingGroupCall.caller_user_id,
        reused: true,
      };
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO call_sessions
           (caller_user_id, callee_user_id, group_id, call_type)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
      [userId, null, groupId, callType]
    );

    return {
      callId: inserted.rows[0]!.id,
      callerUserId: userId,
      reused: false,
    };
  });
}

async function publishCurrentDeviceJoinedGroupCall(
  params: {
    groupId: string;
    callId: string;
    userId: string;
    deviceId: string;
    sessionId: string;
    joinedAt: string;
  },
  added: Awaited<ReturnType<typeof addGroupCallParticipant>>
): Promise<void> {
  const { groupId, callId, userId, deviceId, sessionId, joinedAt } = params;

  if (added.deviceAdded) {
    await publishGroupCallEvent(groupId, {
      type: "group.call.participant_device_joined",
      groupId,
      callId,
      userId,
      deviceId,
      sessionId,
      joinedAt,
    });
  }

  if (added.userAdded) {
    await publishGroupCallEvent(groupId, {
      type: "group.call.participant_joined",
      groupId,
      callId,
      userId,
      deviceId,
      sessionId,
      joinedAt,
    });
  }
}

async function addCurrentDeviceToGroupCall(params: {
  groupId: string;
  callId: string;
  userId: string;
  deviceId: string;
  sessionId: string;
}): Promise<void> {
  const added = await addGroupCallParticipant(
    params.callId,
    params.userId,
    params.deviceId
  );
  await publishCurrentDeviceJoinedGroupCall(
    { ...params, joinedAt: new Date().toISOString() },
    added
  );
}

function notifyOfflineGroupMembersAboutStartedCall(
  request: FastifyRequest,
  params: {
    groupId: string;
    callId: string;
    callerUserId: string;
    callType: CreateCallBody["callType"];
  }
): void {
  const { groupId, callId, callerUserId, callType } = params;

  void (async () => {
    const [callerRows, groupInfoRows, memberRows] = await Promise.all([
      query<{ username: string }>("SELECT username FROM users WHERE id = $1", [
        callerUserId,
      ]),
      query<{ name: string }>("SELECT name FROM groups WHERE id = $1", [
        groupId,
      ]),
      query<{ user_id: string }>(
        "SELECT user_id FROM group_members WHERE group_id = $1 AND user_id != $2 AND removed_at IS NULL",
        [groupId, callerUserId]
      ),
    ]);
    const callerUsername = callerRows[0]?.username ?? null;
    const groupName = groupInfoRows[0]?.name ?? null;

    await Promise.all(
      memberRows.map(async ({ user_id: memberId }) => {
        if (await hasActiveConnectionForUserAcrossCluster(memberId)) return;

        const preferences = await getPushPreferences(memberId);
        const payload = buildGroupCallStartedPushPayload({
          callerUserId,
          callerUsername,
          groupId,
          groupName,
          callId,
          callType,
          preferences,
        });
        if (!payload) return;

        await sendPushToUser(memberId, payload);
      })
    );
  })().catch((err) => {
    request.log.warn(
      { err, groupId },
      "push notification failed for group call start"
    );
    recordPushNotificationFailure();
  });
}

async function createOrJoinGroupCall(
  request: FastifyRequest,
  params: {
    groupId: string;
    userId: string;
    deviceId: string;
    sessionId: string;
    callType: CreateCallBody["callType"];
  }
): Promise<Extract<CreateCallResponse, { created: boolean }>> {
  const { groupId, userId, deviceId, sessionId, callType } = params;
  const groupCall = await reserveGroupCall(groupId, userId, callType);

  if (groupCall.reused) {
    await addCurrentDeviceToGroupCall({
      groupId,
      callId: groupCall.callId,
      userId,
      deviceId,
      sessionId,
    });
    return {
      callId: groupCall.callId,
      callerUserId: groupCall.callerUserId,
      created: false,
    };
  }

  recordCallEvent("initiated");
  const initialPresence = await addGroupCallParticipant(
    groupCall.callId,
    userId,
    deviceId
  );
  await publishGroupCallEvent(groupId, {
    type: "group.call.started",
    groupId,
    callId: groupCall.callId,
    callType,
    callerUserId: userId,
    startedAt: new Date().toISOString(),
  });
  notifyOfflineGroupMembersAboutStartedCall(request, {
    groupId,
    callId: groupCall.callId,
    callerUserId: userId,
    callType,
  });
  await publishCurrentDeviceJoinedGroupCall(
    {
      groupId,
      callId: groupCall.callId,
      userId,
      deviceId,
      sessionId,
      joinedAt: new Date().toISOString(),
    },
    initialPresence
  );

  return {
    callId: groupCall.callId,
    callerUserId: groupCall.callerUserId,
    created: true,
  };
}

function notifyCalleeAboutMissedCall(
  request: FastifyRequest,
  params: {
    callerUserId: string;
    calleeUserId: string;
    callId: string;
    callType: CreateCallBody["callType"];
  }
): void {
  const { callerUserId, calleeUserId, callId, callType } = params;

  void (async () => {
    const callerRows = await query<{ username: string }>(
      "SELECT username FROM users WHERE id = $1",
      [callerUserId]
    );
    const callerUsername = callerRows[0]?.username ?? null;
    const pushPreferences = await getPushPreferences(calleeUserId);
    const payload = buildMissedCallPushPayload({
      callerUserId,
      callerUsername,
      callId,
      callType,
      preferences: pushPreferences,
    });
    if (!payload) return;

    await sendPushToUser(calleeUserId, payload);
  })().catch((err) => {
    request.log.warn(
      { err, calleeUserId },
      "push notification failed for missed call"
    );
    recordPushNotificationFailure();
  });
}

function notifyOfflineDirectCalleeAboutInvite(
  request: FastifyRequest,
  params: {
    callerUserId: string;
    calleeUserId: string;
    callId: string;
    callType: CreateCallBody["callType"];
  }
): void {
  const { callerUserId, calleeUserId, callId, callType } = params;

  void (async () => {
    const callerRows = await query<{ username: string }>(
      "SELECT username FROM users WHERE id = $1",
      [callerUserId]
    );
    const callerUsername = callerRows[0]?.username ?? null;
    const pushPreferences = await getPushPreferences(calleeUserId);
    const payload = buildCallInvitePushPayload({
      callerUserId,
      callerUsername,
      callId,
      callType,
      preferences: pushPreferences,
    });
    if (!payload) return;

    await sendPushToUser(calleeUserId, payload);
  })().catch((err) => {
    request.log.warn(
      { err, calleeUserId },
      "push notification failed for call invite"
    );
    recordPushNotificationFailure();
  });
}

async function createDirectCall(
  request: FastifyRequest,
  params: {
    callerUserId: string;
    calleeUserId: string;
    callType: CreateCallBody["callType"];
  }
): Promise<{ callId: string }> {
  const { callerUserId, calleeUserId, callType } = params;
  const rows = await query<{ id: string }>(
    `INSERT INTO call_sessions
         (caller_user_id, callee_user_id, group_id, call_type)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
    [callerUserId, calleeUserId, null, callType]
  );
  const callId = rows[0]!.id;

  if (!(await hasActiveConnectionForUserAcrossCluster(calleeUserId))) {
    notifyOfflineDirectCalleeAboutInvite(request, {
      callerUserId,
      calleeUserId,
      callId,
      callType,
    });
  }

  recordCallEvent("initiated");
  return { callId };
}

async function handleCreateCallRequest(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<CreateCallResponse | undefined> {
  const body = parseOrReply(reply, CreateCallBodySchema, request.body);
  if (!body) return undefined;
  if (!(await validateCreateCallTarget(reply, request.auth.sub, body))) {
    return undefined;
  }

  if (body.groupId) {
    return createOrJoinGroupCall(request, {
      groupId: body.groupId,
      userId: request.auth.sub,
      deviceId: request.auth.deviceId,
      sessionId: request.auth.sessionId,
      callType: body.callType,
    });
  }

  return createDirectCall(request, {
    callerUserId: request.auth.sub,
    calleeUserId: body.calleeUserId!,
    callType: body.callType,
  });
}

async function loadCallSessionById(
  callId: string
): Promise<ActiveCallSession | null> {
  const call = await query<ActiveCallSession>(
    `SELECT id, caller_user_id, callee_user_id, group_id, call_type, status
     FROM call_sessions
     WHERE id = $1`,
    [callId]
  );
  return call[0] ?? null;
}

function isTerminalCallStatus(status: UpdateCallStatusBody["status"]): boolean {
  return status === "ended" || status === "missed" || status === "rejected";
}

async function authorizeCallStatusUpdate(
  reply: FastifyReply,
  currentCall: ActiveCallSession,
  userId: string,
  nextStatus: UpdateCallStatusBody["status"]
): Promise<boolean> {
  if (!currentCall.group_id) {
    if (currentCall.caller_user_id === userId || currentCall.callee_user_id === userId) {
      return true;
    }
    void reply.code(403).send({ error: "Forbidden" });
    return false;
  }

  const membership = await hasActiveGroupMembership(currentCall.group_id, userId);
  if (!membership) {
    void reply.code(403).send({ error: "Forbidden" });
    return false;
  }

  if (isTerminalCallStatus(nextStatus) && !canEndGroupCallForEveryone(currentCall, userId)) {
    void reply
      .code(403)
      .send({ error: "Only the call host can end the room for everyone" });
    return false;
  }

  return true;
}

async function updateCallStatus(
  callId: string,
  status: UpdateCallStatusBody["status"]
): Promise<void> {
  await query<{ id: string }>(
    `UPDATE call_sessions
     SET status = $1,
         answered_at = CASE WHEN $1 = 'active' THEN now() ELSE answered_at END,
         ended_at    = CASE WHEN $1 IN ('ended','missed','rejected') THEN now() ELSE ended_at END
     WHERE id = $2
     RETURNING id`,
    [status, callId]
  );
}

function recordCallStatusTransition(status: UpdateCallStatusBody["status"]): void {
  if (status === "active") recordCallEvent("accepted");
  else if (status === "ended") recordCallEvent("ended");
  else if (status === "missed") recordCallEvent("missed");
  else if (status === "rejected") recordCallEvent("rejected");
}

async function publishGroupCallEndedAfterStatusChange(
  currentCall: ActiveCallSession,
  nextStatus: UpdateCallStatusBody["status"],
  endedByUserId: string
): Promise<void> {
  if (!currentCall.group_id) return;
  if (currentCall.status === nextStatus || !isTerminalCallStatus(nextStatus)) {
    return;
  }

  await clearGroupCallParticipants(currentCall.id);
  await publishGroupCallEvent(currentCall.group_id, {
    type: "group.call.ended",
    groupId: currentCall.group_id,
    callId: currentCall.id,
    callerUserId: currentCall.caller_user_id,
    endedByUserId,
    endedAt: new Date().toISOString(),
    wasMissed: currentCall.status === "ringing",
  });
}

async function handleUpdateCallStatusRequest(
  request: FastifyRequest<{ Params: { callId: string } }>,
  reply: FastifyReply
): Promise<{ ok: true } | undefined> {
  const { callId } = request.params;
  const body = parseOrReply(reply, UpdateCallStatusBodySchema, request.body);
  if (!body) return undefined;

  const currentCall = await loadCallSessionById(callId);
  if (!currentCall) {
    void reply.code(404).send({ error: "Call not found" });
    return undefined;
  }

  if (!currentCall.group_id) {
    void reply.code(400).send({ error: "Use direct call lifecycle endpoints" });
    return undefined;
  }

  const userId = request.auth.sub;
  if (!(await authorizeCallStatusUpdate(reply, currentCall, userId, body.status))) {
    return undefined;
  }

  await updateCallStatus(callId, body.status);
  recordCallStatusTransition(body.status);
  await publishGroupCallEndedAfterStatusChange(currentCall, body.status, userId);

  return { ok: true };
}

function generateTurnCredentials(userId: string): {
  username: string;
  password: string;
  ttl: number;
  uris: string[];
} {
  const ttl = 86400;
  const timestamp = Math.floor(Date.now() / 1000) + ttl;
  const username = `${timestamp}:${userId}`;
  const password = createHmac("sha1", config.TURN_SECRET)
    .update(username)
    .digest("base64");

  return {
    username,
    password,
    ttl,
    uris: [
      `stun:${config.TURN_DOMAIN}:${config.TURN_PORT}`,
      `turn:${config.TURN_DOMAIN}:${config.TURN_PORT}?transport=udp`,
      `turn:${config.TURN_DOMAIN}:${config.TURN_PORT}?transport=tcp`,
      `turns:${config.TURN_DOMAIN}:${config.TURNS_PORT}?transport=tcp`,
    ],
  };
}

export async function callRoutes(fastify: FastifyInstance): Promise<void> {
  const callPreHandlers = [requireAuth, enforceCallRouteRateLimit];
  const callSessionStore = createCallSessionStore(redis);
  const directCallLifecycleManager = createDirectCallLifecycleManager({
    callSessionStore,
    loadUserDeviceIds,
    routeToDevice: async (targetDeviceId, msg) => {
      await publishMessage({
        ...msg,
        recipientDeviceId: targetDeviceId,
      });
    },
    routeToDevices: async (targetDeviceIds, msg) => {
      await Promise.all(
        [...new Set(targetDeviceIds)].map((targetDeviceId) =>
          publishMessage({
            ...msg,
            recipientDeviceId: targetDeviceId,
          })
        )
      );
    },
  });

  fastify.get(
    "/turn-credentials",
    { preHandler: callPreHandlers },
    async (request) => {
      const { sub: userId } = request.auth;
      return generateTurnCredentials(userId);
    }
  );

  // Returns all active group calls across all groups the authenticated user
  // belongs to.  Used by the client on session restore to surface "join call"
  // banners for groups not currently open in the UI.
  fastify.get(
    "/active-group-calls",
    { preHandler: callPreHandlers },
    async (request) => {
      const { sub: userId } = request.auth;
      const rows = await query<{
        group_id: string;
        id: string;
        call_type: "audio" | "video";
        status: "ringing" | "active";
        caller_user_id: string;
        started_at: string;
        answered_at: string | null;
      }>(
        `SELECT cs.group_id, cs.id, cs.call_type, cs.status,
                cs.caller_user_id, cs.started_at, cs.answered_at
         FROM call_sessions cs
         INNER JOIN group_members gm
                 ON gm.group_id = cs.group_id
                AND gm.user_id = $1
                AND gm.removed_at IS NULL
         WHERE cs.group_id IS NOT NULL
           AND cs.status IN ('ringing', 'active')`,
        [userId]
      );
      return GroupActiveCallsResponseSchema.parse({
        version: GROUPS_PROTOCOL_VERSION,
        calls: rows.map((row) => ({
          groupId: row.group_id,
          callId: row.id,
          callType: row.call_type,
          status: row.status,
          callerUserId: row.caller_user_id,
          createdAt: row.started_at,
          answeredAt: row.answered_at,
        })),
      });
    }
  );

  // Returns recent missed direct (1:1) calls where the authenticated user was the
  // callee.  Limited to calls that ended in the last 4 hours so the notification
  // window stays relevant.  Used by the client on session restore to show a
  // "you missed a call from X" banner.
  fastify.get(
    "/missed-direct",
    { preHandler: callPreHandlers },
    async (request) => {
      const { sub: userId } = request.auth;
      const rows = await query<{
        id: string;
        caller_user_id: string;
        caller_username: string;
        call_type: "audio" | "video";
        ended_at: string;
      }>(
        `SELECT cs.id, cs.caller_user_id, u.username AS caller_username,
                cs.call_type, cs.ended_at
         FROM call_sessions cs
         INNER JOIN users u ON u.id = cs.caller_user_id
         WHERE cs.callee_user_id = $1
           AND cs.group_id IS NULL
           AND cs.status = 'missed'
           AND cs.ended_at > now() - interval '4 hours'
         ORDER BY cs.ended_at DESC
         LIMIT 20`,
        [userId]
      );
      return DirectMissedCallsResponseSchema.parse({
        version: GROUPS_PROTOCOL_VERSION,
        calls: rows.map((row) => ({
          callId: row.id,
          callerUserId: row.caller_user_id,
          callerUsername: row.caller_username,
          callType: row.call_type,
          endedAt: new Date(row.ended_at).toISOString(),
        })),
      });
    }
  );

  fastify.post("/", { preHandler: callPreHandlers }, handleCreateCallRequest);

  fastify.get<{ Params: { callId: string } }>(
    "/:callId/sfu-access",
    { preHandler: [enforceCallRouteRateLimit, requireGuestOrAuth] },
    async (request, reply) => {
      const { callId } = request.params;
      const { sub: userId, tokenUse, roomId } = request.auth;

      const call = await getActiveCallSession(callId);
      if (!call) {
        return reply.code(404).send({ error: "Call not found" });
      }

      // Standalone room: allow guest token or authenticated host.
      if (call.is_room) {
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
          return SfuRoomAccessResponseSchema.parse({ version: SFU_PROTOCOL_VERSION, ok: true });
        }
        if (call.caller_user_id !== userId) {
          return reply.code(403).send({ error: "Forbidden" });
        }
        return SfuRoomAccessResponseSchema.parse({ version: SFU_PROTOCOL_VERSION, ok: true });
      }

      // Direct call: only caller or callee.
      if (!call.group_id) {
        if (call.caller_user_id !== userId && call.callee_user_id !== userId) {
          return reply.code(403).send({ error: "Forbidden" });
        }
        return SfuRoomAccessResponseSchema.parse({
          version: SFU_PROTOCOL_VERSION,
          ok: true,
        });
      }

      // Group call: active membership required.
      if (!(await hasActiveGroupMembership(call.group_id, userId))) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      return SfuRoomAccessResponseSchema.parse({
        version: SFU_PROTOCOL_VERSION,
        ok: true,
      });
    }
  );

  fastify.get<{ Params: { callId: string } }>(
    "/:callId/participants",
    { preHandler: callPreHandlers },
    async (request, reply) => {
      const { callId } = request.params;
      const { sub: userId } = request.auth;

      const call = await getActiveCallSession(callId);
      if (!call) {
        return reply.code(404).send({ error: "Call not found" });
      }
      if (!call.group_id) {
        return reply.code(400).send({
          error: "Participant roster is only available for group calls",
        });
      }
      if (!(await hasActiveGroupMembership(call.group_id, userId))) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      return GroupCallParticipantsResponseSchema.parse({
        version: GROUPS_PROTOCOL_VERSION,
        participants: await resolveGroupCallParticipants(callId),
      });
    }
  );

  fastify.get<{ Params: { callId: string } }>(
    "/:callId/participant-devices",
    { preHandler: callPreHandlers },
    async (request, reply) => {
      const { callId } = request.params;
      const { sub: userId } = request.auth;

      const call = await getActiveCallSession(callId);
      if (!call) {
        return reply.code(404).send({ error: "Call not found" });
      }
      if (!call.group_id) {
        return reply.code(400).send({
          error: "Participant roster is only available for group calls",
        });
      }
      if (!(await hasActiveGroupMembership(call.group_id, userId))) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      return GroupCallParticipantDevicesResponseSchema.parse({
        version: GROUPS_PROTOCOL_VERSION,
        participantDevices: await resolveGroupCallParticipantDevices(callId),
      });
    }
  );

  fastify.post<{ Params: { callId: string } }>(
    "/:callId/participants",
    { preHandler: callPreHandlers },
    async (request, reply) => {
      const { callId } = request.params;
      const { sub: userId, deviceId } = request.auth;

      const call = await getActiveCallSession(callId);
      if (!call) {
        return reply.code(404).send({ error: "Call not found" });
      }
      if (!call.group_id) {
        return reply.code(400).send({
          error: "Participant roster is only available for group calls",
        });
      }
      if (!(await hasActiveGroupMembership(call.group_id, userId))) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const added = await addGroupCallParticipant(callId, userId, deviceId);
      const participants = await resolveGroupCallParticipants(callId);

      const joinedAt = new Date().toISOString();
      if (added.deviceAdded) {
        await publishGroupCallEvent(call.group_id, {
          type: "group.call.participant_device_joined",
          groupId: call.group_id,
          callId,
          userId,
          deviceId,
          sessionId: request.auth.sessionId,
          joinedAt,
        });
      }

      if (added.userAdded) {
        await publishGroupCallEvent(call.group_id, {
          type: "group.call.participant_joined",
          groupId: call.group_id,
          callId,
          userId,
          deviceId,
          sessionId: request.auth.sessionId,
          joinedAt,
        });
      }

      return GroupCallJoinResponseSchema.parse({
        version: GROUPS_PROTOCOL_VERSION,
        ok: true,
        participants,
      });
    }
  );

  fastify.delete<{ Params: { callId: string } }>(
    "/:callId/participants/me",
    { preHandler: callPreHandlers },
    async (request, reply) => {
      const { callId } = request.params;
      const { sub: userId, deviceId } = request.auth;

      const call = await getActiveCallSession(callId);
      if (!call) {
        return reply.code(404).send({ error: "Call not found" });
      }
      if (!call.group_id) {
        return reply.code(400).send({
          error: "Participant roster is only available for group calls",
        });
      }
      if (!(await hasActiveGroupMembership(call.group_id, userId))) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const removed = await removeGroupCallParticipant(
        callId,
        userId,
        deviceId
      );
      const leftAt = new Date().toISOString();
      if (removed.deviceRemoved) {
        await publishGroupCallEvent(call.group_id, {
          type: "group.call.participant_device_left",
          groupId: call.group_id,
          callId,
          userId,
          deviceId,
          sessionId: request.auth.sessionId,
          leftAt,
        });
      }

      if (removed.userRemoved) {
        await publishGroupCallEvent(call.group_id, {
          type: "group.call.participant_left",
          groupId: call.group_id,
          callId,
          userId,
          deviceId,
          sessionId: request.auth.sessionId,
          leftAt,
        });
      }

      await endGroupCallIfRosterEmpty(call, userId);

      return { ok: true };
    }
  );

  fastify.put<{ Params: { callId: string } }>(
    "/:callId/participants/me",
    { preHandler: callPreHandlers },
    async (request, reply) => {
      const { callId } = request.params;
      const { sub: userId, deviceId } = request.auth;

      const call = await getActiveCallSession(callId);
      if (!call) {
        return reply.code(404).send({ error: "Call not found" });
      }
      if (!call.group_id) {
        return reply.code(400).send({
          error: "Participant roster is only available for group calls",
        });
      }
      if (!(await hasActiveGroupMembership(call.group_id, userId))) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const refreshed = await refreshGroupCallParticipant(callId, deviceId);
      if (!refreshed) {
        return reply.code(404).send({ error: "Participant not found" });
      }

      return { ok: true };
    }
  );

  fastify.post<{ Params: { callId: string } }>(
    "/:callId/direct-hangup",
    { preHandler: callPreHandlers },
    async (request, reply) => {
      const { callId } = request.params;
      const { sub: userId, deviceId } = request.auth;

      const call = await getActiveCallSession(callId);
      if (!call) {
        return reply.code(404).send({ error: "Call not found" });
      }
      if (call.group_id) {
        return reply
          .code(400)
          .send({ error: "Direct hangup is only available for 1:1 calls" });
      }
      if (call.caller_user_id !== userId && call.callee_user_id !== userId) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const termination = await directCallLifecycleManager.hangupCall({
        callId,
        actorUserId: userId,
        actorDeviceId: deviceId,
      });

      if (!termination.ok && termination.reason === "forbidden") {
        return reply.code(403).send({ error: "Forbidden" });
      }

      if (!termination.ok && termination.reason === "not_found") {
        request.log.warn(
          { callId, actorUserId: userId, actorDeviceId: deviceId },
          "Direct-call routing session missing during direct-hangup; using DB-backed fallback delivery"
        );
        await notifyDirectCallCounterpartDevices(call, userId, "call.hangup");
      }

      // When caller gives up on an unanswered call, send the callee a missed-call push.
      if (
        termination.ok &&
        !termination.alreadyTerminal &&
        termination.resultingStatus === "missed" &&
        call.callee_user_id
      ) {
        notifyCalleeAboutMissedCall(request, {
          callerUserId: call.caller_user_id,
          calleeUserId: call.callee_user_id,
          callId,
          callType: call.call_type,
        });
      }

      return { ok: true };
    }
  );

  fastify.post<{ Params: { callId: string } }>(
    "/:callId/direct-reject",
    { preHandler: callPreHandlers },
    async (request, reply) => {
      const { callId } = request.params;
      const { sub: userId, deviceId } = request.auth;

      const call = await getActiveCallSession(callId);
      if (!call) {
        return reply.code(404).send({ error: "Call not found" });
      }
      if (call.group_id) {
        return reply
          .code(400)
          .send({ error: "Direct reject is only available for 1:1 calls" });
      }
      if (call.caller_user_id !== userId && call.callee_user_id !== userId) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const rejection = await directCallLifecycleManager.rejectCall({
        callId,
        actorUserId: userId,
        actorDeviceId: deviceId,
      });

      if (!rejection.ok && rejection.reason === "forbidden") {
        return reply.code(403).send({ error: "Forbidden" });
      }

      if (!rejection.ok && rejection.reason === "not_found") {
        request.log.warn(
          { callId, actorUserId: userId, actorDeviceId: deviceId },
          "Direct-call routing session missing during direct-reject; using DB-backed fallback delivery"
        );
        await notifyDirectCallCounterpartDevices(call, userId, "call.rejected");
      }

      return { ok: true };
    }
  );

  fastify.put<{ Params: { callId: string } }>(
    "/:callId/status",
    { preHandler: callPreHandlers },
    handleUpdateCallStatusRequest
  );
}
