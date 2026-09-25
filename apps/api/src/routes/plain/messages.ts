/**
 * Plain (cloud-stored) direct message routes.
 *
 * POST /plain/messages/:recipientUserId          → send DM
 * GET  /plain/messages/:recipientUserId          → paginated history
 * POST /plain/messages/:recipientUserId/read     → mark thread as read
 * PATCH /plain/messages/:id                      → edit
 * DELETE /plain/messages/:id                     → soft-delete
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../../middleware/auth.js";
import { query } from "../../db/pool.js";
import { parseOrReply } from "../../utils/validation.js";
import { consumeFixedWindowRateLimit } from "../../utils/fixed-window-rate-limit.js";
import { publishPlainMessageToUser } from "../../services/plain-ws.js";
import { getPushPreferences, sendPushToUser } from "../../services/push.js";
import { buildDirectMessagePushPayload } from "../../services/push-payloads.js";
import { hasActiveConnectionForUserAcrossCluster } from "../../services/websocket.js";
import { buildDownloadUrl } from "./attachments.js";
import { isVisibleDirectReplyTarget } from "./reply-target.js";
import { resolveBrowserOrigin } from "../../utils/request-origin.js";
import {
  SendPlainMessageRequestSchema,
  EditPlainMessageRequestSchema,
} from "@seclettr/protocol";

async function fetchUsername(userId: string): Promise<string | null> {
  const [row] = await query<{ username: string }>(
    "SELECT username FROM users WHERE id = $1",
    [userId]
  );
  return row?.username ?? null;
}

/** 120 plain DMs per user per minute */
const SEND_RATE_MAX = 120;
const SEND_RATE_WINDOW_SEC = 60;

const PAGE_LIMIT = 50;

interface PlainMsgRow {
  id: string;
  client_id: string;
  sender_user_id: string;
  sender_username: string;
  recipient_user_id: string;
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

function buildMessageWire(row: PlainMsgRow, downloadUrl?: string) {
  return {
    id: row.id,
    clientId: row.client_id,
    senderUserId: row.sender_user_id,
    senderUsername: row.sender_username,
    recipientUserId: row.recipient_user_id,
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

const HISTORY_SQL = `
  SELECT
    pm.id,
    pm.client_id,
    pm.sender_user_id,
    u.username AS sender_username,
    pm.recipient_user_id,
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
    AND pm.recipient_user_id IS NOT NULL
    AND (
      (pm.sender_user_id = $1 AND pm.recipient_user_id = $2) OR
      (pm.sender_user_id = $2 AND pm.recipient_user_id = $1)
    )
`;

export async function plainMessageRoutes(fastify: FastifyInstance): Promise<void> {
  /** Send a plain DM */
  fastify.post(
    "/:recipientUserId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { recipientUserId } = request.params as { recipientUserId: string };

      if (recipientUserId === userId) {
        return reply.code(400).send({ error: "Cannot message yourself" });
      }

      const limited = await consumeFixedWindowRateLimit({
        key: `plain_dm:${userId}`,
        max: SEND_RATE_MAX,
        windowSec: SEND_RATE_WINDOW_SEC,
      });
      if (!limited.allowed) return reply.code(429).send({ error: "Rate limit exceeded" });

      const body = parseOrReply(reply, SendPlainMessageRequestSchema, request.body);
      if (!body) return;

      // Verify recipient exists and fetch both usernames in parallel
      const [[recipient], senderUsername, _recipientUsername] = await Promise.all([
        query<{ id: string }>("SELECT id FROM users WHERE id = $1", [recipientUserId]),
        fetchUsername(userId),
        fetchUsername(recipientUserId),
      ]);
      if (!recipient) return reply.code(404).send({ error: "Recipient not found" });

      // Verify attachment if provided and fetch its metadata for wire message
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

      // A reply target must be visible in this exact thread; otherwise the
      // history JOIN would disclose another conversation's message body.
      if (body.replyToId) {
        const replyTargetVisible = await isVisibleDirectReplyTarget({
          replyToId: body.replyToId,
          userId,
          recipientUserId,
        });
        if (!replyTargetVisible) {
          return reply.code(400).send({ error: "Reply target not found in this conversation" });
        }
      }

      const newMsgId = randomUUID();
      const now = new Date().toISOString();

      // Idempotent insert: if a row with this client_id already exists, the
      // CTE returns no rows from `ins` and the SELECT below falls through to
      // the existing row. We use the result to decide whether to fan out WS
      // events and push notifications — duplicates are silently absorbed.
      // `to_char(... at time zone 'UTC' ...)` keeps the response shape identical
      // regardless of whether the row was just inserted (we passed an ISO string)
      // or fetched from a duplicate (pg returns a Date object) — protocol clients
      // and downstream WS payloads expect a string.
      const [persisted] = await query<{ id: string; created_at: string; inserted: boolean }>(
        `WITH ins AS (
           INSERT INTO plain_messages
             (id, client_id, sender_user_id, recipient_user_id, content, message_type,
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
          recipientUserId,
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
        // Duplicate retry — message is already stored and was already broadcast
        // on the first attempt. Acknowledge with the original id/createdAt so
        // the client converges on the canonical row.
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
        recipientUserId,
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

      // Push to recipient via WS
      await publishPlainMessageToUser(recipientUserId, {
        type: "plain_message.new",
        message: wireMsg,
      });
      // Also push to own other devices/sessions
      await publishPlainMessageToUser(userId, {
        type: "plain_message.new",
        message: wireMsg,
      });

      // Push notification if recipient is offline
      if (!(await hasActiveConnectionForUserAcrossCluster(recipientUserId))) {
        try {
          const prefs = await getPushPreferences(recipientUserId);
          const payload = buildDirectMessagePushPayload({
            senderUserId: userId,
            senderUsername: senderUsername ?? null,
            hasAttachment: !!body.attachmentId,
            messageText: body.messageType === "text" ? body.content : null,
            mediaSummary: {
              messageType: body.messageType,
              mimeType: attMeta?.content_type,
            },
            preferences: prefs,
          });
          if (payload) {
            await sendPushToUser(recipientUserId, payload);
          }
        } catch (err) {
          request.log.warn({ err, recipientUserId }, "plain DM push notification failed");
        }
      }

      return reply.code(201).send({
        id: msgId,
        clientId: body.clientId,
        createdAt,
      });
    }
  );

  /** Paginated history */
  fastify.get(
    "/:recipientUserId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { recipientUserId } = request.params as { recipientUserId: string };
      const { before, limit } = request.query as { before?: string; limit?: string };

      const parsedLimit = Number(limit);
      const pageLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(Math.floor(parsedLimit), PAGE_LIMIT)
        : PAGE_LIMIT;
      if (before !== undefined && (typeof before !== "string" || Number.isNaN(Date.parse(before)))) {
        return reply.code(400).send({ error: "Invalid cursor" });
      }
      const cursorClause = before ? `AND pm.created_at < $3` : "";
      const params: unknown[] = [userId, recipientUserId];
      if (before) params.push(before);

      const rows = await query<PlainMsgRow>(
        `${HISTORY_SQL} ${cursorClause}
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
          return buildMessageWire(row, downloadUrl);
        })
      );
      const nextCursor = hasMore ? rows[pageLimit - 1]?.created_at : undefined;

      return reply.code(200).send({ messages, hasMore, nextCursor });
    }
  );

  /** Mark thread as read — inserts read receipts for all unread inbound messages */
  fastify.post(
    "/:peerUserId/read",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { peerUserId } = request.params as { peerUserId: string };

      // Find all messages sent by peer to us that we haven't marked read yet
      const unread = await query<{ id: string }>(
        `SELECT pm.id FROM plain_messages pm
         WHERE pm.sender_user_id = $1
           AND pm.recipient_user_id = $2
           AND pm.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM plain_message_reads pmr
             WHERE pmr.message_id = pm.id AND pmr.user_id = $2
           )`,
        [peerUserId, userId]
      );

      if (unread.length === 0) return reply.code(204).send();

      const ids = unread.map((r) => r.id);
      // Bulk insert read receipts in chunks. Postgres caps bound parameters at
      // 32 767; with 2 params per row we stay well under by chunking at 500.
      const READ_RECEIPT_CHUNK = 500;
      for (let offset = 0; offset < ids.length; offset += READ_RECEIPT_CHUNK) {
        const chunk = ids.slice(offset, offset + READ_RECEIPT_CHUNK);
        const placeholders = chunk.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ");
        const values: string[] = [];
        for (const id of chunk) values.push(id, userId);
        await query(
          `INSERT INTO plain_message_reads (message_id, user_id) VALUES ${placeholders}
           ON CONFLICT DO NOTHING`,
          values
        );
      }

      const now = new Date().toISOString();
      // Notify the peer that their messages were read
      await publishPlainMessageToUser(peerUserId, {
        type: "plain_message.read",
        messageIds: ids,
        readerUserId: userId,
        threadKey: userId,
        threadKind: "dm",
        readAt: now,
      });

      return reply.code(204).send();
    }
  );

  /** Edit */
  fastify.patch(
    "/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { id } = request.params as { id: string };

      const body = parseOrReply(reply, EditPlainMessageRequestSchema, request.body);
      if (!body) return;

      // Constrain to DM messages only — group messages must use the group endpoint,
      // otherwise authorization bypasses group-membership checks and broadcast events
      // are routed to a NULL recipient.
      const [msg] = await query<{ id: string; sender_user_id: string; recipient_user_id: string; message_type: string }>(
        `SELECT id, sender_user_id, recipient_user_id, message_type
         FROM plain_messages
         WHERE id = $1 AND deleted_at IS NULL AND recipient_user_id IS NOT NULL`,
        [id]
      );
      if (!msg) return reply.code(404).send({ error: "Message not found" });
      if (msg.sender_user_id !== userId) return reply.code(403).send({ error: "Forbidden" });
      if (msg.message_type !== "text") return reply.code(400).send({ error: "Only text messages can be edited" });

      const editedAt = new Date().toISOString();
      await query(
        `UPDATE plain_messages SET content = $1, edited_at = $2 WHERE id = $3`,
        [body.content, editedAt, id]
      );

      // threadKey is the peer's userId from the receiving side's perspective:
      // recipient stores the conversation under sender_user_id (= userId here),
      // sender stores it under recipient_user_id.
      await publishPlainMessageToUser(msg.recipient_user_id, {
        type: "plain_message.edited" as const,
        messageId: id,
        content: body.content,
        editedAt,
        threadKey: userId,
        threadKind: "dm" as const,
      });
      await publishPlainMessageToUser(userId, {
        type: "plain_message.edited" as const,
        messageId: id,
        content: body.content,
        editedAt,
        threadKey: msg.recipient_user_id,
        threadKind: "dm" as const,
      });

      return reply.code(200).send({ id, editedAt });
    }
  );

  /** Soft-delete */
  fastify.delete(
    "/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { id } = request.params as { id: string };

      // DM-only — see PATCH endpoint comment.
      const [msg] = await query<{ id: string; sender_user_id: string; recipient_user_id: string }>(
        `SELECT id, sender_user_id, recipient_user_id
         FROM plain_messages
         WHERE id = $1 AND deleted_at IS NULL AND recipient_user_id IS NOT NULL`,
        [id]
      );
      if (!msg) return reply.code(404).send({ error: "Message not found" });
      if (msg.sender_user_id !== userId) return reply.code(403).send({ error: "Forbidden" });

      const deletedAt = new Date().toISOString();
      await query(`UPDATE plain_messages SET deleted_at = $1 WHERE id = $2`, [deletedAt, id]);

      // threadKey must be the peer's userId from each side's perspective.
      await publishPlainMessageToUser(msg.recipient_user_id, {
        type: "plain_message.deleted" as const,
        messageId: id,
        threadKey: userId,
        threadKind: "dm" as const,
      });
      await publishPlainMessageToUser(userId, {
        type: "plain_message.deleted" as const,
        messageId: id,
        threadKey: msg.recipient_user_id,
        threadKind: "dm" as const,
      });

      return reply.code(204).send();
    }
  );
}
