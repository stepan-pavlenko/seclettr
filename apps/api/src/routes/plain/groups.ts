/**
 * Plain group routes.
 *
 * POST   /plain/groups                          → create group
 * GET    /plain/groups                          → list my groups
 * GET    /plain/groups/:id                      → get group details
 * PATCH  /plain/groups/:id                      → rename / update description
 * POST   /plain/groups/:id/avatar               → upload group avatar (admin+)
 * DELETE /plain/groups/:id/avatar               → remove group avatar (admin+)
 * GET    /plain/groups/:id/avatar               → serve avatar image (member)
 * POST   /plain/groups/:id/members              → add member
 * DELETE /plain/groups/:id/members/:userId      → remove member
 * POST   /plain/groups/:id/messages             → send group message
 * GET    /plain/groups/:id/messages             → paginated group history
 * PATCH  /plain/groups/:id/messages/:msgId      → edit group message
 * DELETE /plain/groups/:id/messages/:msgId      → delete group message
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { requireAuth } from "../../middleware/auth.js";
import { query, transaction } from "../../db/pool.js";
import { parseOrReply } from "../../utils/validation.js";
import { consumeFixedWindowRateLimit } from "../../utils/fixed-window-rate-limit.js";
import { publishPlainMessageToUser } from "../../services/plain-ws.js";
import { getPushPreferences, sendPushToUser } from "../../services/push.js";
import { buildGroupMessagePushPayload } from "../../services/push-payloads.js";
import { hasActiveConnectionForUserAcrossCluster } from "../../services/websocket.js";
import { buildDownloadUrl } from "./attachments.js";
import { isVisibleGroupReplyTarget } from "./reply-target.js";
import { resolveBrowserOrigin } from "../../utils/request-origin.js";
import { config } from "../../config.js";
import {
  SendPlainMessageRequestSchema,
  EditPlainMessageRequestSchema,
  CreatePlainGroupRequestSchema,
  AddPlainGroupMemberRequestSchema,
  UpdatePlainGroupMemberRoleRequestSchema,
  RenamePlainGroupRequestSchema,
} from "@seclettr/protocol";

// ─── Avatar storage ────────────────────────────────────────────────────────────
const GROUP_AVATAR_MAX_BYTES = 4 * 1024 * 1024;
const GROUP_AVATAR_ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const GROUP_AVATAR_PREFIX = "group-avatars/";

const GROUP_AVATAR_UPLOAD_RATE_WINDOW_SEC = 60 * 5;
const GROUP_AVATAR_UPLOAD_RATE_MAX = 5;

const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  },
  forcePathStyle: true,
});

async function fetchUsername(userId: string): Promise<string | null> {
  const [row] = await query<{ username: string }>(
    "SELECT username FROM users WHERE id = $1",
    [userId]
  );
  return row?.username ?? null;
}

const CREATE_RATE_MAX = 5;
const CREATE_RATE_WINDOW_SEC = 3600;
const SEND_RATE_MAX = 60;
const SEND_RATE_WINDOW_SEC = 60;
const GROUP_MAX_MEMBERS = 256;
const USER_MAX_GROUPS = 200;
const PAGE_LIMIT = 50;

interface GroupRow {
  id: string;
  name: string;
  creator_id: string;
  avatar_key: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface MemberRow {
  user_id: string;
  username: string;
  role: string;
  joined_at: string;
}

interface PlainGroupMsgRow {
  id: string;
  client_id: string;
  sender_user_id: string;
  sender_username: string;
  group_id: string;
  content: string;
  message_type: string;
  attachment_id: string | null;
  reply_to_id: string | null;
  duration_ms: number | null;
  media_group_id: string | null;
  created_at: string;
  edited_at: string | null;
  att_content_type: string | null;
  att_file_name: string | null;
  att_size: string | null;
  att_storage_key: string | null;
  reply_content: string | null;
  reply_sender_username: string | null;
}

async function getActiveMembership(
  groupId: string,
  userId: string
): Promise<{ role: string } | null> {
  const [row] = await query<{ role: string }>(
    `SELECT role FROM plain_group_members
     WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
    [groupId, userId]
  );
  return row ?? null;
}

function buildGroupMsgWire(row: PlainGroupMsgRow, downloadUrl?: string) {
  return {
    id: row.id,
    clientId: row.client_id,
    senderUserId: row.sender_user_id,
    senderUsername: row.sender_username,
    groupId: row.group_id,
    content: row.content,
    messageType: row.message_type,
    attachment: row.attachment_id
      ? {
          attachmentId: row.attachment_id,
          contentType: row.att_content_type ?? "",
          fileName: row.att_file_name ?? undefined,
          size: Number(row.att_size ?? 0),
          durationMs: row.duration_ms ?? undefined,
          mediaGroupId: row.media_group_id ?? undefined,
          downloadUrl,
        }
      : undefined,
    replyTo: row.reply_to_id
      ? {
          id: row.reply_to_id,
          content: row.reply_content ?? "",
          senderName: row.reply_sender_username ?? undefined,
        }
      : undefined,
    createdAt: row.created_at,
    editedAt: row.edited_at ?? undefined,
  };
}

const GROUP_HISTORY_SQL = `
  SELECT
    pm.id,
    pm.client_id,
    pm.sender_user_id,
    u.username   AS sender_username,
    pm.group_id,
    pm.content,
    pm.message_type,
    pm.attachment_id,
    pm.reply_to_id,
    pm.duration_ms,
    pm.media_group_id,
    pm.created_at,
    pm.edited_at,
    pa.content_type  AS att_content_type,
    pa.file_name     AS att_file_name,
    pa.encrypted_size AS att_size,
    pa.storage_key   AS att_storage_key,
    rp.content       AS reply_content,
    ru.username      AS reply_sender_username
  FROM plain_messages pm
  JOIN users u ON u.id = pm.sender_user_id
  LEFT JOIN plain_attachments pa ON pa.id = pm.attachment_id
  LEFT JOIN plain_messages rp ON rp.id = pm.reply_to_id
  LEFT JOIN users ru ON ru.id = rp.sender_user_id
  WHERE pm.deleted_at IS NULL
    AND pm.group_id = $1
`;

export async function plainGroupRoutes(fastify: FastifyInstance): Promise<void> {
  /** Create group */
  fastify.post(
    "/",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;

      const limited = await consumeFixedWindowRateLimit({
        key: `plain_group_create:${userId}`,
        max: CREATE_RATE_MAX,
        windowSec: CREATE_RATE_WINDOW_SEC,
      });
      if (!limited.allowed) return reply.code(429).send({ error: "Rate limit exceeded" });

      const body = parseOrReply(reply, CreatePlainGroupRequestSchema, request.body);
      if (!body) return;

      const memberIds = [...new Set([userId, ...body.memberUserIds])];
      if (memberIds.length > GROUP_MAX_MEMBERS) {
        return reply.code(400).send({ error: `Too many members (max ${GROUP_MAX_MEMBERS})` });
      }

      // Validate all member IDs exist
      const existingUsers = await query<{ id: string; username: string }>(
        "SELECT id, username FROM users WHERE id = ANY($1::uuid[])",
        [memberIds]
      );
      if (existingUsers.length !== memberIds.length) {
        return reply.code(400).send({ error: "Some member IDs are invalid" });
      }

      // Check user group limit
      const countRow = await query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM plain_group_members
         WHERE user_id = $1 AND removed_at IS NULL`,
        [userId]
      );
      if (Number(countRow[0]?.count ?? 0) >= USER_MAX_GROUPS) {
        return reply.code(400).send({ error: "Group limit reached" });
      }

      const groupId = randomUUID();
      const now = new Date().toISOString();

      await transaction(async (client) => {
        await client.query(
          `INSERT INTO plain_groups (id, name, creator_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4)`,
          [groupId, body.name, userId, now]
        );
        for (const memberId of memberIds) {
          const role = memberId === userId ? "owner" : "member";
          await client.query(
            `INSERT INTO plain_group_members (group_id, user_id, role, joined_at)
             VALUES ($1, $2, $3, $4)`,
            [groupId, memberId, role, now]
          );
        }
      });

      const members = existingUsers.map((u) => ({
        userId: u.id,
        username: u.username,
        role: u.id === userId ? "owner" : "member",
        joinedAt: now,
      }));

      const groupWire = {
        id: groupId,
        name: body.name,
        creatorId: userId,
        members,
        createdAt: now,
        updatedAt: now,
      };

      return reply.code(201).send(groupWire);
    }
  );

  /** List my groups */
  fastify.get(
    "/",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;

      // Single-query fetch: list of groups + their active members. Eliminates the
      // N+1 round-trip that previously fired one members query per group.
      const rows = await query<{
        group_id: string;
        group_name: string;
        creator_id: string;
        avatar_key: string | null;
        description: string | null;
        created_at: string;
        updated_at: string;
        member_user_id: string;
        member_username: string;
        member_role: string;
        member_joined_at: string;
      }>(
        `SELECT
           pg.id              AS group_id,
           pg.name            AS group_name,
           pg.creator_id,
           pg.avatar_key,
           pg.description,
           pg.created_at,
           pg.updated_at,
           pgm.user_id        AS member_user_id,
           u.username         AS member_username,
           pgm.role           AS member_role,
           pgm.joined_at      AS member_joined_at
         FROM plain_groups pg
         JOIN plain_group_members pgm ON pgm.group_id = pg.id AND pgm.removed_at IS NULL
         JOIN users u ON u.id = pgm.user_id
         WHERE EXISTS (
           SELECT 1 FROM plain_group_members me
           WHERE me.group_id = pg.id AND me.user_id = $1 AND me.removed_at IS NULL
         )
         ORDER BY pg.updated_at DESC, pg.id, pgm.joined_at`,
        [userId]
      );

      const grouped = new Map<string, {
        id: string;
        name: string;
        creatorId: string;
        avatarKey: string | null;
        description: string | null;
        members: Array<{ userId: string; username: string; role: string; joinedAt: string }>;
        createdAt: string;
        updatedAt: string;
      }>();
      for (const row of rows) {
        let group = grouped.get(row.group_id);
        if (!group) {
          group = {
            id: row.group_id,
            name: row.group_name,
            creatorId: row.creator_id,
            avatarKey: row.avatar_key ?? null,
            description: row.description ?? null,
            members: [],
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };
          grouped.set(row.group_id, group);
        }
        group.members.push({
          userId: row.member_user_id,
          username: row.member_username,
          role: row.member_role,
          joinedAt: row.member_joined_at,
        });
      }

      return reply.code(200).send({ groups: Array.from(grouped.values()) });
    }
  );

  /** Get group details */
  fastify.get(
    "/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { id } = request.params as { id: string };

      const membership = await getActiveMembership(id, userId);
      if (!membership) return reply.code(403).send({ error: "Not a member" });

      const [g] = await query<GroupRow>(
        `SELECT id, name, creator_id, avatar_key, description, created_at, updated_at
         FROM plain_groups WHERE id = $1`,
        [id]
      );
      if (!g) return reply.code(404).send({ error: "Group not found" });

      const members = await query<MemberRow>(
        `SELECT pgm.user_id, u.username, pgm.role, pgm.joined_at
         FROM plain_group_members pgm
         JOIN users u ON u.id = pgm.user_id
         WHERE pgm.group_id = $1 AND pgm.removed_at IS NULL`,
        [id]
      );

      return reply.code(200).send({
        id: g.id,
        name: g.name,
        creatorId: g.creator_id,
        avatarKey: g.avatar_key ?? null,
        description: g.description ?? null,
        members: members.map((m) => ({
          userId: m.user_id,
          username: m.username,
          role: m.role,
          joinedAt: m.joined_at,
        })),
        createdAt: g.created_at,
        updatedAt: g.updated_at,
      });
    }
  );

  /** Rename group (owner / admin). Triggers an `updated_at` bump used by the
   *  sidebar to re-sort the group entry. */
  fastify.patch(
    "/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { id } = request.params as { id: string };

      const membership = await getActiveMembership(id, userId);
      if (!membership) return reply.code(403).send({ error: "Not a member" });
      if (membership.role === "member") return reply.code(403).send({ error: "Insufficient role" });

      // Accept rename (required) + optional description update
      const rawBody = request.body as Record<string, unknown>;

      // Description-only update (no name change)
      if ("description" in rawBody && !("name" in rawBody)) {
        const desc = rawBody["description"];
        if (desc !== null && typeof desc !== "string") {
          return reply.code(400).send({ error: "description must be a string or null" });
        }
        if (typeof desc === "string" && desc.length > 500) {
          return reply.code(400).send({ error: "description too long (max 500 chars)" });
        }
        const [updated] = await query<{ id: string; name: string; description: string | null; updated_at: string }>(
          `UPDATE plain_groups SET description = $1 WHERE id = $2
           RETURNING id, name, description,
             to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`,
          [desc ?? null, id]
        );
        if (!updated) return reply.code(404).send({ error: "Group not found" });
        return reply.code(200).send({
          id: updated.id,
          name: updated.name,
          description: updated.description,
          updatedAt: updated.updated_at,
        });
      }

      const body = parseOrReply(reply, RenamePlainGroupRequestSchema, request.body);
      if (!body) return;

      const trimmed = body.name.trim();
      if (!trimmed) return reply.code(400).send({ error: "Name cannot be empty" });

      const [updated] = await query<{ id: string; name: string; description: string | null; updated_at: string }>(
        `UPDATE plain_groups SET name = $1 WHERE id = $2
         RETURNING id, name, description,
           to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`,
        [trimmed, id]
      );
      if (!updated) return reply.code(404).send({ error: "Group not found" });

      return reply.code(200).send({
        id: updated.id,
        name: updated.name,
        description: updated.description,
        updatedAt: updated.updated_at,
      });
    }
  );

  /** Upload group avatar (admin / owner only) */
  fastify.post(
    "/:id/avatar",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { id } = request.params as { id: string };

      const membership = await getActiveMembership(id, userId);
      if (!membership) return reply.code(403).send({ error: "Not a member" });
      if (membership.role === "member") return reply.code(403).send({ error: "Insufficient role" });

      const rateOk = await consumeFixedWindowRateLimit({
        key: `rate:group-avatar:v1:${userId}:${id}`,
        max: GROUP_AVATAR_UPLOAD_RATE_MAX,
        windowSec: GROUP_AVATAR_UPLOAD_RATE_WINDOW_SEC,
      });
      if (!rateOk.allowed) {
        reply.header("Retry-After", String(rateOk.retryAfterSec));
        return reply.code(429).send({ error: "Too many avatar upload requests" });
      }

      const data = await request.file({ limits: { fileSize: GROUP_AVATAR_MAX_BYTES } });
      if (!data) return reply.code(400).send({ error: "No file provided" });

      const contentType = data.mimetype ?? "application/octet-stream";
      if (!GROUP_AVATAR_ALLOWED_TYPES.has(contentType)) {
        data.file.resume();
        return reply.code(400).send({
          error: `Unsupported image type. Allowed: ${[...GROUP_AVATAR_ALLOWED_TYPES].join(", ")}`,
        });
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      for await (const chunk of data.file) {
        totalBytes += chunk.length;
        if (totalBytes > GROUP_AVATAR_MAX_BYTES) {
          return reply.code(413).send({ error: "Avatar image too large (max 4 MB)" });
        }
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      const storageKey = `${GROUP_AVATAR_PREFIX}${id}`;
      await s3.send(new PutObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: storageKey,
        Body: buffer,
        ContentType: contentType,
        ContentLength: buffer.length,
      }));

      const [updated] = await query<{ id: string; name: string; avatar_key: string | null; updated_at: string }>(
        `UPDATE plain_groups SET avatar_key = $1 WHERE id = $2
         RETURNING id, name, avatar_key,
           to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`,
        [storageKey, id]
      );
      if (!updated) return reply.code(404).send({ error: "Group not found" });

      return reply.code(200).send({
        id: updated.id,
        name: updated.name,
        avatarKey: updated.avatar_key,
        updatedAt: updated.updated_at,
      });
    }
  );

  /** Delete group avatar (admin / owner only) */
  fastify.delete(
    "/:id/avatar",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { id } = request.params as { id: string };

      const membership = await getActiveMembership(id, userId);
      if (!membership) return reply.code(403).send({ error: "Not a member" });
      if (membership.role === "member") return reply.code(403).send({ error: "Insufficient role" });

      const storageKey = `${GROUP_AVATAR_PREFIX}${id}`;
      await s3.send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: storageKey })).catch(() => undefined);

      const [updated] = await query<{ id: string; name: string; avatar_key: string | null; updated_at: string }>(
        `UPDATE plain_groups SET avatar_key = NULL WHERE id = $1
         RETURNING id, name, avatar_key,
           to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`,
        [id]
      );
      if (!updated) return reply.code(404).send({ error: "Group not found" });

      return reply.code(200).send({
        id: updated.id,
        name: updated.name,
        avatarKey: null,
        updatedAt: updated.updated_at,
      });
    }
  );

  /** Serve group avatar image (any member) */
  fastify.get(
    "/:id/avatar",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { id } = request.params as { id: string };

      const membership = await getActiveMembership(id, userId);
      if (!membership) return reply.code(403).send({ error: "Not a member" });

      const storageKey = `${GROUP_AVATAR_PREFIX}${id}`;
      let object;
      try {
        object = await s3.send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: storageKey }));
      } catch {
        return reply.code(404).send({ error: "Avatar not found" });
      }

      const contentType = object.ContentType ?? "image/jpeg";
      reply.header("Content-Type", contentType);
      reply.header("Cache-Control", "private, max-age=300");
      if (object.ContentLength) reply.header("Content-Length", String(object.ContentLength));

      const { Readable } = await import("node:stream");
      return reply.send(object.Body as InstanceType<typeof Readable>);
    }
  );

  /** Add member */
  fastify.post(
    "/:id/members",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { id } = request.params as { id: string };

      const membership = await getActiveMembership(id, userId);
      if (!membership) return reply.code(403).send({ error: "Not a member" });
      if (membership.role === "member") return reply.code(403).send({ error: "Insufficient role" });

      const body = parseOrReply(reply, AddPlainGroupMemberRequestSchema, request.body);
      if (!body) return;

      const [targetUser] = await query<{ id: string; username: string }>(
        "SELECT id, username FROM users WHERE id = $1",
        [body.userId]
      );
      if (!targetUser) return reply.code(404).send({ error: "User not found" });

      const memberCountRows = await query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM plain_group_members
         WHERE group_id = $1 AND removed_at IS NULL`,
        [id]
      );
      if (Number(memberCountRows[0]?.count ?? 0) >= GROUP_MAX_MEMBERS) {
        return reply.code(400).send({ error: "Group is full" });
      }

      const now = new Date().toISOString();
      await query(
        `INSERT INTO plain_group_members (group_id, user_id, role, joined_at)
         VALUES ($1, $2, 'member', $3)
         ON CONFLICT (group_id, user_id) DO UPDATE
           SET removed_at = NULL, joined_at = $3`,
        [id, body.userId, now]
      );

      return reply.code(200).send({ userId: body.userId, joinedAt: now });
    }
  );

  /** Update member role (owner-only). Used for ownership transfer / admin promotion. */
  fastify.patch(
    "/:id/members/:memberId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { id, memberId } = request.params as { id: string; memberId: string };

      const membership = await getActiveMembership(id, userId);
      if (!membership) return reply.code(403).send({ error: "Not a member" });
      if (membership.role !== "owner") return reply.code(403).send({ error: "Insufficient role" });

      const body = parseOrReply(reply, UpdatePlainGroupMemberRoleRequestSchema, request.body);
      if (!body) return;

      const targetMembership = await getActiveMembership(id, memberId);
      if (!targetMembership) return reply.code(404).send({ error: "Member not found" });
      if (targetMembership.role === body.role) return reply.code(204).send();

      // Prevent demoting the last owner — group would be left without one.
      if (targetMembership.role === "owner" && body.role !== "owner") {
        const ownerCountRows = await query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM plain_group_members
           WHERE group_id = $1 AND role = 'owner' AND removed_at IS NULL`,
          [id]
        );
        if (Number(ownerCountRows[0]?.count ?? 0) <= 1) {
          return reply.code(409).send({ error: "Cannot demote the last owner" });
        }
      }

      // Promoting another member to owner is interpreted as a *transfer*:
      // a group must have exactly one owner, so demote the caller (current
      // owner) to admin in the same transaction. Without this the previous
      // owner stayed alongside the new one and the group ended up with two.
      if (body.role === "owner" && memberId !== userId) {
        await transaction(async (client) => {
          await client.query(
            `UPDATE plain_group_members SET role = 'admin'
             WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
            [id, userId]
          );
          await client.query(
            `UPDATE plain_group_members SET role = 'owner'
             WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
            [id, memberId]
          );
        });
        return reply.code(204).send();
      }

      await query(
        `UPDATE plain_group_members SET role = $1
         WHERE group_id = $2 AND user_id = $3 AND removed_at IS NULL`,
        [body.role, id, memberId]
      );

      return reply.code(204).send();
    }
  );

  /** Remove member */
  fastify.delete(
    "/:id/members/:memberId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { id, memberId } = request.params as { id: string; memberId: string };

      const membership = await getActiveMembership(id, userId);
      if (!membership) return reply.code(403).send({ error: "Not a member" });

      const isSelf = memberId === userId;
      if (!isSelf && membership.role === "member") {
        return reply.code(403).send({ error: "Insufficient role" });
      }

      const targetMembership = isSelf
        ? membership
        : await getActiveMembership(id, memberId);
      if (!targetMembership) return reply.code(404).send({ error: "Member not found" });

      // Refuse to orphan the group — last owner must transfer the role first
      // via PATCH /:id/members/:memberId.
      if (targetMembership.role === "owner") {
        const ownerCountRows = await query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM plain_group_members
           WHERE group_id = $1 AND role = 'owner' AND removed_at IS NULL`,
          [id]
        );
        if (Number(ownerCountRows[0]?.count ?? 0) <= 1) {
          return reply.code(409).send({
            error: "Cannot remove the last owner — transfer ownership first",
          });
        }
      }

      await query(
        `UPDATE plain_group_members SET removed_at = now()
         WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
        [id, memberId]
      );

      return reply.code(204).send();
    }
  );

  /** Send group message */
  fastify.post(
    "/:id/messages",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { id: groupId } = request.params as { id: string };

      const [membership, senderUsername] = await Promise.all([
        getActiveMembership(groupId, userId),
        fetchUsername(userId),
      ]);
      if (!membership) return reply.code(403).send({ error: "Not a member" });

      const limited = await consumeFixedWindowRateLimit({
        key: `plain_group_send:${userId}`,
        max: SEND_RATE_MAX,
        windowSec: SEND_RATE_WINDOW_SEC,
      });
      if (!limited.allowed) return reply.code(429).send({ error: "Rate limit exceeded" });

      const body = parseOrReply(reply, SendPlainMessageRequestSchema, request.body);
      if (!body) return;

      let attMeta: { id: string; content_type: string; file_name: string | null; encrypted_size: string } | null = null;
      if (body.attachmentId) {
        const [att] = await query<{
          id: string;
          uploader_user_id: string;
          upload_state: string;
          content_type: string;
          file_name: string | null;
          encrypted_size: string;
        }>(
          "SELECT id, uploader_user_id, upload_state, content_type, file_name, encrypted_size FROM plain_attachments WHERE id = $1",
          [body.attachmentId]
        );
        if (!att || att.upload_state !== "verified") {
          return reply.code(422).send({ error: "Attachment not ready" });
        }
        if (att.uploader_user_id !== userId) {
          return reply.code(403).send({ error: "Attachment not owned by sender" });
        }
        attMeta = att;
      }

      // A reply target must belong to this group and not be deleted; otherwise
      // the history JOIN would disclose another conversation's message body.
      if (body.replyToId) {
        const replyTargetVisible = await isVisibleGroupReplyTarget({
          replyToId: body.replyToId,
          groupId,
        });
        if (!replyTargetVisible) {
          return reply.code(400).send({ error: "Reply target not found in this group" });
        }
      }

      const newMsgId = randomUUID();
      const now = new Date().toISOString();

      // Idempotent insert — see DM endpoint for the rationale.
      const [persisted] = await query<{ id: string; created_at: string; inserted: boolean }>(
        `WITH ins AS (
           INSERT INTO plain_messages
             (id, client_id, sender_user_id, group_id, content, message_type,
              attachment_id, reply_to_id, media_group_id, duration_ms, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (client_id) DO NOTHING
           RETURNING id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
         )
         SELECT id, created_at, true AS inserted FROM ins
         UNION ALL
         SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at, false AS inserted
           FROM plain_messages
           WHERE client_id = $2 AND NOT EXISTS (SELECT 1 FROM ins)
         LIMIT 1`,
        [
          newMsgId,
          body.clientId,
          userId,
          groupId,
          body.content,
          body.messageType,
          body.attachmentId ?? null,
          body.replyToId ?? null,
          body.mediaGroupId ?? null,
          body.durationMs ?? null,
          now,
        ]
      );

      if (!persisted) {
        return reply.code(500).send({ error: "Failed to persist message" });
      }

      const msgId = persisted.id;
      const createdAt = persisted.created_at;

      if (!persisted.inserted) {
        return reply.code(200).send({
          id: msgId,
          clientId: body.clientId,
          createdAt,
        });
      }

      const wireMsg = {
        id: msgId,
        clientId: body.clientId,
        senderUserId: userId,
        senderUsername: senderUsername ?? userId,
        groupId,
        content: body.content,
        messageType: body.messageType,
        attachment: attMeta
          ? {
              attachmentId: attMeta.id,
              contentType: attMeta.content_type,
              fileName: attMeta.file_name ?? undefined,
              size: Number(attMeta.encrypted_size),
              durationMs: body.durationMs ?? undefined,
              mediaGroupId: body.mediaGroupId ?? undefined,
            }
          : undefined,
        createdAt,
      };

      // Fan-out to all active group members
      const members = await query<{ user_id: string }>(
        `SELECT user_id FROM plain_group_members WHERE group_id = $1 AND removed_at IS NULL`,
        [groupId]
      );

      const [groupRow] = await query<{ name: string }>(
        `SELECT name FROM plain_groups WHERE id = $1`,
        [groupId]
      );

      await Promise.all(
        members.map(async (m) => {
          await publishPlainMessageToUser(m.user_id, {
            type: "plain_message.new",
            message: wireMsg,
          });

          if (m.user_id === userId) return;
          if (await hasActiveConnectionForUserAcrossCluster(m.user_id)) return;

          try {
            const prefs = await getPushPreferences(m.user_id);
            const payload = buildGroupMessagePushPayload({
              senderUserId: userId,
              senderUsername: senderUsername ?? null,
              groupId,
              groupName: groupRow?.name ?? null,
              messageText: body.messageType === "text" ? body.content : null,
              mediaSummary: {
                messageType: body.messageType,
                mimeType: attMeta?.content_type,
              },
              preferences: prefs,
            });
            if (payload) await sendPushToUser(m.user_id, payload);
          } catch (err) {
            request.log.warn({ err, userId: m.user_id }, "plain group push failed");
          }
        })
      );

      return reply.code(201).send({
        id: msgId,
        clientId: body.clientId,
        createdAt,
      });
    }
  );

  /** Paginated group history */
  fastify.get(
    "/:id/messages",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { id: groupId } = request.params as { id: string };

      const membership = await getActiveMembership(groupId, userId);
      if (!membership) return reply.code(403).send({ error: "Not a member" });

      const { before, limit } = request.query as { before?: string; limit?: string };
      const parsedLimit = Number(limit);
      const pageLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(Math.floor(parsedLimit), PAGE_LIMIT)
        : PAGE_LIMIT;
      if (before !== undefined && (typeof before !== "string" || Number.isNaN(Date.parse(before)))) {
        return reply.code(400).send({ error: "Invalid cursor" });
      }
      const cursorClause = before ? `AND pm.created_at < $2` : "";
      const params: unknown[] = [groupId];
      if (before) params.push(before);

      const rows = await query<PlainGroupMsgRow>(
        `${GROUP_HISTORY_SQL} ${cursorClause}
         ORDER BY pm.created_at DESC
         LIMIT ${pageLimit + 1}`,
        params
      );

      const hasMore = rows.length > pageLimit;
      const pageRows = rows.slice(0, pageLimit);
      const origin = resolveBrowserOrigin(request.headers);
      const messages = await Promise.all(
        pageRows.map(async (row) => {
          const downloadUrl = row.att_storage_key
            ? await buildDownloadUrl(row.att_storage_key, origin).catch(() => undefined)
            : undefined;
          return buildGroupMsgWire(row, downloadUrl);
        })
      );
      const nextCursor = hasMore ? rows[pageLimit - 1]?.created_at : undefined;

      return reply.code(200).send({ messages, hasMore, nextCursor });
    }
  );

  /** Edit group message */
  fastify.patch(
    "/:id/messages/:msgId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { id: groupId, msgId } = request.params as { id: string; msgId: string };

      const membership = await getActiveMembership(groupId, userId);
      if (!membership) return reply.code(403).send({ error: "Not a member" });

      const body = parseOrReply(reply, EditPlainMessageRequestSchema, request.body);
      if (!body) return;

      const [msg] = await query<{ id: string; sender_user_id: string; message_type: string }>(
        `SELECT id, sender_user_id, message_type
         FROM plain_messages WHERE id = $1 AND group_id = $2 AND deleted_at IS NULL`,
        [msgId, groupId]
      );
      if (!msg) return reply.code(404).send({ error: "Message not found" });
      if (msg.sender_user_id !== userId) return reply.code(403).send({ error: "Forbidden" });
      if (msg.message_type !== "text") return reply.code(400).send({ error: "Only text messages can be edited" });

      const editedAt = new Date().toISOString();
      await query(
        `UPDATE plain_messages SET content = $1, edited_at = $2 WHERE id = $3`,
        [body.content, editedAt, msgId]
      );

      const members = await query<{ user_id: string }>(
        `SELECT user_id FROM plain_group_members WHERE group_id = $1 AND removed_at IS NULL`,
        [groupId]
      );

      const editEvent = {
        type: "plain_message.edited" as const,
        messageId: msgId,
        content: body.content,
        editedAt,
        threadKey: groupId,
        threadKind: "group" as const,
      };
      await Promise.all(members.map((m) => publishPlainMessageToUser(m.user_id, editEvent)));

      return reply.code(200).send({ id: msgId, editedAt });
    }
  );

  /** Delete group message */
  fastify.delete(
    "/:id/messages/:msgId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { id: groupId, msgId } = request.params as { id: string; msgId: string };

      const membership = await getActiveMembership(groupId, userId);
      if (!membership) return reply.code(403).send({ error: "Not a member" });

      const [msg] = await query<{ id: string; sender_user_id: string }>(
        `SELECT id, sender_user_id
         FROM plain_messages WHERE id = $1 AND group_id = $2 AND deleted_at IS NULL`,
        [msgId, groupId]
      );
      if (!msg) return reply.code(404).send({ error: "Message not found" });

      const canDelete =
        msg.sender_user_id === userId ||
        membership.role === "owner" ||
        membership.role === "admin";
      if (!canDelete) return reply.code(403).send({ error: "Forbidden" });

      await query(
        `UPDATE plain_messages SET deleted_at = now() WHERE id = $1`,
        [msgId]
      );

      const members = await query<{ user_id: string }>(
        `SELECT user_id FROM plain_group_members WHERE group_id = $1 AND removed_at IS NULL`,
        [groupId]
      );

      const deleteEvent = {
        type: "plain_message.deleted" as const,
        messageId: msgId,
        threadKey: groupId,
        threadKind: "group" as const,
      };
      await Promise.all(members.map((m) => publishPlainMessageToUser(m.user_id, deleteEvent)));

      return reply.code(204).send();
    }
  );
}
