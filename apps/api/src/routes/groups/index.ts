import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../middleware/auth.js";
import { query, transaction } from "../../db/pool.js";
import { consumeFixedWindowRateLimit } from "../../utils/fixed-window-rate-limit.js";
import { parseVersionedOrReply } from "../../utils/validation.js";
import { publishMessage } from "../../services/redis.js";
import { appendAuditEvent } from "../../services/audit-log.js";
import {
  GROUPS_PROTOCOL_VERSION,
  CreateGroupRequestSchema,
  AddMemberRequestSchema,
  GroupActiveCallSchema,
  GroupMemberDevicesResponseSchema,
  UpdateGroupMemberRoleRequestSchema,
  GroupMemberRoleSchema,
  GroupListResponseSchema,
  GroupMutationResponseSchema,
  GroupResponseSchema,
} from "@seclettr/protocol";

async function findMissingUserIds(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const existing = await query<{ id: string }>(
    "SELECT id FROM users WHERE id = ANY($1::uuid[])",
    [userIds]
  );
  const existingSet = new Set(existing.map((row) => row.id));
  return userIds
    .filter((userId) => !existingSet.has(userId))
    .sort((left, right) => left.localeCompare(right));
}

type GroupMemberRole = "owner" | "admin" | "member";
type GroupMembership = { group_id: string; role: GroupMemberRole };
type ActiveGroupCallRow = {
  id: string;
  call_type: "audio" | "video";
  status: "ringing" | "active";
  caller_user_id: string;
  started_at: string;
  answered_at: string | null;
};

function canManageMembers(role: GroupMemberRole): boolean {
  return role === "owner" || role === "admin";
}

async function getActiveMembership(groupId: string, userId: string): Promise<GroupMembership | null> {
  const membership = await query<GroupMembership>(
    "SELECT group_id, role FROM group_members WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL",
    [groupId, userId]
  );
  return membership[0] ?? null;
}

/** Maximum members per group (including the creator). */
const GROUP_MAX_MEMBERS = 256;
/** Maximum groups a single user can be a member of. */
const USER_MAX_GROUPS = 500;

/** 5 group creations per user per hour. */
const CREATE_GROUP_RATE_MAX = 5;
const CREATE_GROUP_RATE_WINDOW_SEC = 60 * 60;

/** 20 add-member calls per user per minute. */
const ADD_MEMBER_RATE_MAX = 20;
const ADD_MEMBER_RATE_WINDOW_SEC = 60;

export async function groupRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    "/",
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = parseVersionedOrReply(
        reply,
        CreateGroupRequestSchema,
        request.body,
        GROUPS_PROTOCOL_VERSION
      );
      if (!body) return;
      const { sub: userId } = request.auth;

      const createLimit = await consumeFixedWindowRateLimit({
        key: `rl:create_group:${userId}`,
        max: CREATE_GROUP_RATE_MAX,
        windowSec: CREATE_GROUP_RATE_WINDOW_SEC,
      });
      if (!createLimit.allowed) {
        return reply
          .code(429)
          .header("Retry-After", String(createLimit.retryAfterSec))
          .send({ error: "Too many requests" });
      }

      const memberIds = Array.from(new Set([userId, ...body.memberUserIds]));
      if (memberIds.length > GROUP_MAX_MEMBERS) {
        return reply.code(400).send({ error: `Group size limit is ${GROUP_MAX_MEMBERS}` });
      }

      const userGroupCountRows = await query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
         FROM group_members
         WHERE user_id = $1 AND removed_at IS NULL`,
        [userId]
      );
      if (Number.parseInt(userGroupCountRows[0]?.cnt ?? "0", 10) >= USER_MAX_GROUPS) {
        return reply.code(400).send({ error: `Groups per user limit reached (${USER_MAX_GROUPS})` });
      }

      const missingUserIds = await findMissingUserIds(memberIds);
      if (missingUserIds.length > 0) {
        return reply.code(404).send({
          error: "Users not found",
          missingUserIds,
        });
      }

      const createdGroup = await transaction(async (client) => {
        const groupRows = await client.query<{ id: string }>(
          "INSERT INTO groups (name, creator_id) VALUES ($1, $2) RETURNING id",
          [body.name, userId]
        );
        const groupId = groupRows.rows[0]!.id;

        for (const memberId of memberIds) {
          const role: GroupMemberRole = memberId === userId ? "owner" : "member";
          await client.query(
            "INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
            [groupId, memberId, role]
          );
        }

        const memberDetails = await client.query<{
          user_id: string;
          username: string;
          joined_at: string;
          role: GroupMemberRole;
        }>(
          `SELECT gm.user_id, u.username, gm.joined_at, gm.role
           FROM group_members gm
           INNER JOIN users u ON u.id = gm.user_id
           WHERE gm.group_id = $1 AND gm.removed_at IS NULL`,
          [groupId]
        );

        return {
          groupId,
          name: body.name,
          createdAt: new Date().toISOString(),
          cryptoEpoch: 1,
          members: memberDetails.rows.map((member) => ({
            userId: member.user_id,
            username: member.username,
            joinedAt: new Date(member.joined_at).toISOString(),
            role: GroupMemberRoleSchema.parse(member.role),
          })),
        };
      });

      return reply.code(201).send(
        GroupResponseSchema.parse({
          version: GROUPS_PROTOCOL_VERSION,
          ...createdGroup,
        })
      );
    }
  );

  const GROUP_LIST_MAX_LIMIT = 100;
  const GROUP_LIST_DEFAULT_LIMIT = 50;

  fastify.get<{ Querystring: { cursor?: string; limit?: string } }>(
    "/",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const limit = Math.min(
        Number.parseInt(request.query.limit ?? String(GROUP_LIST_DEFAULT_LIMIT), 10) || GROUP_LIST_DEFAULT_LIMIT,
        GROUP_LIST_MAX_LIMIT
      );
      const cursor = request.query.cursor ?? null;
      // cursor encodes the created_at timestamp of the last seen group (ISO string, base64url)
      let cursorTs: string | null = null;
      if (cursor) {
        try {
          const decoded = Buffer.from(cursor, "base64url").toString("utf8");
          // Validate it is a real ISO timestamp before using in a query
          if (!Number.isFinite(new Date(decoded).getTime())) {
            return reply.code(400).send({ error: "Invalid cursor" });
          }
          cursorTs = decoded;
        } catch {
          return reply.code(400).send({ error: "Invalid cursor" });
        }
      }

      const groups = await query<{
        id: string;
        name: string;
        created_at: string;
        crypto_epoch: number;
      }>(
        `SELECT g.id, g.name, g.created_at, g.crypto_epoch
         FROM groups g
         INNER JOIN group_members gm ON gm.group_id = g.id
         WHERE gm.user_id = $1
           AND gm.removed_at IS NULL
           ${cursorTs ? "AND g.created_at < $3" : ""}
         ORDER BY g.created_at DESC
         LIMIT $2`,
        cursorTs ? [userId, limit + 1, cursorTs] : [userId, limit + 1]
      );

      const hasMore = groups.length > limit;
      const page = hasMore ? groups.slice(0, limit) : groups;
      const nextCursor = hasMore
        ? Buffer.from(new Date(page.at(-1)!.created_at).toISOString()).toString("base64url")
        : undefined;

      return GroupListResponseSchema.parse({
        version: GROUPS_PROTOCOL_VERSION,
        groups: page.map(g => ({
          groupId: g.id,
          name: g.name,
          createdAt: new Date(g.created_at).toISOString(),
          cryptoEpoch: g.crypto_epoch,
        })),
        nextCursor,
      });
    }
  );

  fastify.get<{ Params: { groupId: string } }>(
    "/:groupId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { groupId } = request.params;
      const { sub: userId } = request.auth;

      const membership = await getActiveMembership(groupId, userId);
      if (!membership) {
        return reply.code(403).send({ error: "Not a group member" });
      }

      const groups = await query<{
        id: string;
        name: string;
        created_at: string;
        crypto_epoch: number;
      }>(
        "SELECT id, name, created_at, crypto_epoch FROM groups WHERE id = $1",
        [groupId]
      );
      if (groups.length === 0) return reply.code(404).send({ error: "Group not found" });

      const members = await query<{ user_id: string; username: string; joined_at: string; role: GroupMemberRole }>(
        `SELECT gm.user_id, u.username, gm.joined_at, gm.role
         FROM group_members gm
         INNER JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id = $1 AND gm.removed_at IS NULL`,
        [groupId]
      );

      const group = groups[0]!;
      return GroupResponseSchema.parse({
        version: GROUPS_PROTOCOL_VERSION,
        groupId: group.id,
        name: group.name,
        createdAt: new Date(group.created_at).toISOString(),
        cryptoEpoch: group.crypto_epoch,
        members: members.map(m => ({
          userId: m.user_id,
          username: m.username,
          joinedAt: new Date(m.joined_at).toISOString(),
          role: GroupMemberRoleSchema.parse(m.role),
        })),
      });
    }
  );

  fastify.get<{ Params: { groupId: string } }>(
    "/:groupId/active-call",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { groupId } = request.params;
      const { sub: userId } = request.auth;

      const membership = await getActiveMembership(groupId, userId);
      if (!membership) {
        return reply.code(403).send({ error: "Not a group member" });
      }

      const activeCalls = await query<ActiveGroupCallRow>(
        `SELECT id, call_type, status, caller_user_id, started_at, answered_at
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

      if (activeCalls.length === 0) {
        return reply.code(404).send({ error: "No active call" });
      }

      const activeCall = activeCalls[0]!;
      return GroupActiveCallSchema.parse({
        version: GROUPS_PROTOCOL_VERSION,
        callId: activeCall.id,
        callType: activeCall.call_type,
        status: activeCall.status,
        callerUserId: activeCall.caller_user_id,
        createdAt: new Date(activeCall.started_at).toISOString(),
        answeredAt: activeCall.answered_at
          ? new Date(activeCall.answered_at).toISOString()
          : null,
      });
    }
  );
  fastify.get<{ Params: { groupId: string } }>(
    "/:groupId/member-devices",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { groupId } = request.params;
      const { sub: userId } = request.auth;

      const membership = await getActiveMembership(groupId, userId);
      if (!membership) {
        return reply.code(403).send({ error: "Not a group member" });
      }

      const rows = await query<{
        user_id: string;
        device_id: string;
        identity_key_public: string;
        signing_key_public: string;
      }>(
        `SELECT gm.user_id, d.id AS device_id, d.identity_key_public, d.signing_key_public
         FROM group_members gm
         INNER JOIN devices d ON d.user_id = gm.user_id
         WHERE gm.group_id = $1 AND gm.removed_at IS NULL
         ORDER BY gm.joined_at ASC, d.created_at ASC`,
        [groupId]
      );

      const membersByUserId = new Map<string, {
        userId: string;
        devices: Array<{
          deviceId: string;
          identityKeyPublic: string;
          signingKeyPublic: string;
        }>;
      }>();

      for (const row of rows) {
        const current = membersByUserId.get(row.user_id) ?? {
          userId: row.user_id,
          devices: [],
        };
        current.devices.push({
          deviceId: row.device_id,
          identityKeyPublic: row.identity_key_public,
          signingKeyPublic: row.signing_key_public,
        });
        membersByUserId.set(row.user_id, current);
      }

      return GroupMemberDevicesResponseSchema.parse({
        version: GROUPS_PROTOCOL_VERSION,
        members: Array.from(membersByUserId.values()),
      });
    }
  );

  fastify.post<{ Params: { groupId: string } }>(
    "/:groupId/members",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { groupId } = request.params;
      const body = parseVersionedOrReply(
        reply,
        AddMemberRequestSchema,
        request.body,
        GROUPS_PROTOCOL_VERSION
      );
      if (!body) return;
      const { sub: userId } = request.auth;

      const addMemberLimit = await consumeFixedWindowRateLimit({
        key: `rl:add_group_member:${userId}`,
        max: ADD_MEMBER_RATE_MAX,
        windowSec: ADD_MEMBER_RATE_WINDOW_SEC,
      });
      if (!addMemberLimit.allowed) {
        return reply
          .code(429)
          .header("Retry-After", String(addMemberLimit.retryAfterSec))
          .send({ error: "Too many requests" });
      }

      const membership = await getActiveMembership(groupId, userId);
      if (!membership) {
        return reply.code(403).send({ error: "Not a group member" });
      }
      if (!canManageMembers(membership.role)) {
        return reply.code(403).send({ error: "Insufficient group permissions" });
      }

      const targetRole = body.role ?? "member";
      if (targetRole === "owner") {
        return reply.code(400).send({ error: "Owner role cannot be assigned through this endpoint" });
      }
      if (targetRole === "admin" && membership.role !== "owner") {
        return reply.code(403).send({ error: "Only owner can assign admin role" });
      }

      const targetUserIds = Array.from(new Set(body.userIds));
      const missingUserIds = await findMissingUserIds(targetUserIds);
      if (missingUserIds.length > 0) {
        return reply.code(404).send({
          error: "Users not found",
          missingUserIds,
        });
      }

      const addResult = await transaction(async (client) => {
        // Lock the group row so concurrent add-member calls are serialized:
        // the member-count check and the inserts must be atomic, otherwise two
        // requests can each pass the limit check and together exceed
        // GROUP_MAX_MEMBERS (AUDIT.md Medium).
        await client.query("SELECT id FROM groups WHERE id = $1 FOR UPDATE", [
          groupId,
        ]);

        const currentMemberCountRows = await client.query<{ member_count: number }>(
          `SELECT COUNT(*)::int AS member_count
           FROM group_members
           WHERE group_id = $1 AND removed_at IS NULL`,
          [groupId]
        );
        const currentMemberCount = Number(
          currentMemberCountRows.rows[0]?.member_count ?? 0
        );

        const existingTargets = await client.query<{ user_id: string }>(
          `SELECT user_id
           FROM group_members
           WHERE group_id = $1
             AND user_id = ANY($2::uuid[])
             AND removed_at IS NULL`,
          [groupId, targetUserIds]
        );
        const existingMemberSet = new Set(
          existingTargets.rows.map((row) => row.user_id)
        );
        const trulyNewUserIds = targetUserIds.filter(
          (id) => !existingMemberSet.has(id)
        );

        if (currentMemberCount + trulyNewUserIds.length > GROUP_MAX_MEMBERS) {
          return { limitExceeded: true as const };
        }

        for (const newUserId of targetUserIds) {
          await client.query(
            `INSERT INTO group_members (group_id, user_id, role)
             VALUES ($1, $2, $3)
             ON CONFLICT (group_id, user_id) DO UPDATE
             SET removed_at = NULL,
                 joined_at = now(),
                 role = EXCLUDED.role
             WHERE group_members.removed_at IS NOT NULL`,
            [groupId, newUserId, targetRole]
          );
        }

        return { limitExceeded: false as const, trulyNewUserIds };
      });

      if (addResult.limitExceeded) {
        return reply
          .code(400)
          .send({ error: `Group size limit is ${GROUP_MAX_MEMBERS}` });
      }
      const { trulyNewUserIds } = addResult;

      let cryptoEpoch: number | undefined;
      if (trulyNewUserIds.length > 0) {
        const epochRows = await query<{ crypto_epoch: number }>(
          `UPDATE groups
           SET crypto_epoch = crypto_epoch + 1
           WHERE id = $1
           RETURNING crypto_epoch`,
          [groupId]
        );
        cryptoEpoch = epochRows[0]?.crypto_epoch;
        const addedAt = new Date().toISOString();
        const activeMemberDevices = await query<{ id: string }>(
          `SELECT d.id
           FROM devices d
           INNER JOIN group_members gm ON gm.user_id = d.user_id
           WHERE gm.group_id = $1 AND gm.removed_at IS NULL`,
          [groupId]
        );
        await Promise.all(
          activeMemberDevices.map((device) =>
            publishMessage({
              type: "group.member_added",
              groupId,
              addedByUserId: userId,
              addedAt,
              cryptoEpoch,
              recipientDeviceId: device.id,
            })
          )
        );
        void appendAuditEvent({
          eventType: "group.member_added",
          actorUserId: userId,
          actorDeviceId: request.auth.deviceId,
          targetId: groupId,
          ipAddress: request.ip,
          metadata: { addedUserIds: trulyNewUserIds },
        });
      }

      return GroupMutationResponseSchema.parse({
        version: GROUPS_PROTOCOL_VERSION,
        ok: true,
        cryptoEpoch,
      });
    }
  );

  fastify.delete<{ Params: { groupId: string; memberUserId: string } }>(
    "/:groupId/members/:memberUserId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { groupId, memberUserId } = request.params;
      const { sub: userId } = request.auth;

      const requesterMembership = await getActiveMembership(groupId, userId);
      if (!requesterMembership) {
        return reply.code(403).send({ error: "Not a group member" });
      }

      const targetMembershipRows = await query<{ role: GroupMemberRole }>(
        "SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL",
        [groupId, memberUserId]
      );
      const targetMembership = targetMembershipRows[0];
      if (!targetMembership) {
        return reply.code(404).send({ error: "Member not found" });
      }

      const isSelfRemoval = userId === memberUserId;
      if (!isSelfRemoval) {
        if (requesterMembership.role === "member") {
          return reply.code(403).send({ error: "Insufficient group permissions" });
        }
        if (requesterMembership.role === "admin" && targetMembership.role !== "member") {
          return reply.code(403).send({ error: "Admin can remove members only" });
        }
      }

      if (targetMembership.role === "owner") {
        const ownerCountRows = await query<{ owner_count: string }>(
          `SELECT COUNT(*)::int AS owner_count
           FROM group_members
           WHERE group_id = $1 AND role = 'owner' AND removed_at IS NULL`,
          [groupId]
        );
        const ownerCount = Number.parseInt(ownerCountRows[0]?.owner_count ?? "0", 10);
        if (ownerCount <= 1) {
          return reply.code(400).send({ error: "Group must have at least one owner" });
        }
      }

      const removedAt = new Date().toISOString();
      const removal = await transaction(async (client) => {
        await client.query(
          `UPDATE group_members
           SET removed_at = now()
           WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
          [groupId, memberUserId]
        );
        const epochRows = await client.query<{ crypto_epoch: number }>(
          `UPDATE groups
           SET crypto_epoch = crypto_epoch + 1
           WHERE id = $1
           RETURNING crypto_epoch`,
          [groupId]
        );
        const remainingDevices = await client.query<{ id: string }>(
          `SELECT d.id
           FROM devices d
           INNER JOIN group_members gm ON gm.user_id = d.user_id
           WHERE gm.group_id = $1 AND gm.removed_at IS NULL`,
          [groupId]
        );
        const removedDevices = await client.query<{ id: string }>(
          `SELECT id FROM devices WHERE user_id = $1`,
          [memberUserId]
        );
        return {
          cryptoEpoch: epochRows.rows[0]!.crypto_epoch,
          recipientDeviceIds: [
            ...new Set([
              ...remainingDevices.rows.map((device) => device.id),
              ...removedDevices.rows.map((device) => device.id),
            ]),
          ],
        };
      });

      await Promise.all(
        removal.recipientDeviceIds.map((recipientDeviceId) =>
          publishMessage({
            type: "group.member_removed",
            groupId,
            removedUserId: memberUserId,
            removedByUserId: userId,
            removedAt,
            cryptoEpoch: removal.cryptoEpoch,
            recipientDeviceId,
          })
        )
      );

      void appendAuditEvent({
        eventType: isSelfRemoval ? "group.member_left" : "group.member_removed",
        actorUserId: userId,
        actorDeviceId: request.auth.deviceId,
        targetId: groupId,
        ipAddress: request.ip,
        metadata: { removedUserId: memberUserId },
      });

      return GroupMutationResponseSchema.parse({
        version: GROUPS_PROTOCOL_VERSION,
        ok: true,
        cryptoEpoch: removal.cryptoEpoch,
      });
    }
  );

  fastify.put<{ Params: { groupId: string; memberUserId: string } }>(
    "/:groupId/members/:memberUserId/role",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { groupId, memberUserId } = request.params;
      const body = parseVersionedOrReply(
        reply,
        UpdateGroupMemberRoleRequestSchema,
        request.body,
        GROUPS_PROTOCOL_VERSION
      );
      if (!body) return;

      const { sub: userId } = request.auth;
      const requesterMembership = await getActiveMembership(groupId, userId);
      if (!requesterMembership) {
        return reply.code(403).send({ error: "Not a group member" });
      }
      if (requesterMembership.role !== "owner") {
        return reply.code(403).send({ error: "Only owner can update member roles" });
      }

      const targetMembershipRows = await query<{ role: GroupMemberRole }>(
        "SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL",
        [groupId, memberUserId]
      );
      const targetMembership = targetMembershipRows[0];
      if (!targetMembership) {
        return reply.code(404).send({ error: "Member not found" });
      }
      if (targetMembership.role === "owner") {
        return reply.code(400).send({ error: "Owner role cannot be changed through this endpoint" });
      }

      await query(
        `UPDATE group_members
         SET role = $3
         WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
        [groupId, memberUserId, body.role]
      );

      void appendAuditEvent({
        eventType: "group.role_updated",
        actorUserId: userId,
        actorDeviceId: request.auth.deviceId,
        targetId: groupId,
        ipAddress: request.ip,
        metadata: { targetUserId: memberUserId, newRole: body.role, previousRole: targetMembership.role },
      });

      return GroupMutationResponseSchema.parse({
        version: GROUPS_PROTOCOL_VERSION,
        ok: true,
      });
    }
  );
}
