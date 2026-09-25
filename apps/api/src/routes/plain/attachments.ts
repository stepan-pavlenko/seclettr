/**
 * Plain (unencrypted) attachment upload / download.
 *
 * Unlike E2EE attachments the server stores the original file and serves it
 * directly — no client-side encryption keys involved.
 *
 * POST   /plain/attachments/init        → get presigned upload URL
 * POST   /plain/attachments/:id/confirm → mark uploaded, get download URL
 * GET    /plain/attachments/:id         → get fresh download URL
 * DELETE /plain/attachments/:id         → cancel an in-flight upload
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  S3Client,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { requireAuth } from "../../middleware/auth.js";
import { query } from "../../db/pool.js";
import { config } from "../../config.js";
import { parseOrReply } from "../../utils/validation.js";
import { consumeFixedWindowRateLimit } from "../../utils/fixed-window-rate-limit.js";
import { resolveBrowserOrigin } from "../../utils/request-origin.js";
import {
  InitPlainUploadRequestSchema,
} from "@seclettr/protocol";

/** 20 plain uploads per user per minute */
const UPLOAD_RATE_MAX = 20;
const UPLOAD_RATE_WINDOW_SEC = 60;

/** Presigned POST expires in 15 minutes */
const PRESIGNED_UPLOAD_TTL_SEC = 900;
/** Presigned GET expires in 1 hour */
const PRESIGNED_DOWNLOAD_TTL_SEC = 3600;

const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  },
  forcePathStyle: true,
});

const PLAIN_BUCKET = `${config.S3_BUCKET}-plain`;

const USE_IN_MEMORY =
  process.env["QM_API_TEST_USE_IN_MEMORY_SERVICES"] === "1";
const inMemoryObjects = new Map<string, Buffer>();

let bucketReady: Promise<boolean> | null = null;

async function ensureBucket(): Promise<boolean> {
  if (USE_IN_MEMORY) return true;
  if (bucketReady) return bucketReady;
  bucketReady = (async () => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: PLAIN_BUCKET }));
      return true;
    } catch {
      try {
        await s3.send(new CreateBucketCommand({ Bucket: PLAIN_BUCKET }));
        return true;
      } catch {
        return false;
      }
    }
  })();
  return bucketReady;
}

function rewriteS3Url(url: string, requestOrigin?: string): string {
  const base = config.S3_PUBLIC_URL ?? requestOrigin;
  if (!base) return url;
  try {
    const parsed = new URL(url);
    const pub = new URL(base);

    // Build a fresh URL from the browser-facing origin instead of mutating the
    // presigned endpoint in place. This guarantees that internal MinIO ports
    // such as :9000 cannot leak into the upload/download URL returned to the
    // browser, while preserving the bucket path and signed query string.
    return new URL(`${parsed.pathname}${parsed.search}`, pub.origin).toString();
  } catch {
    return url;
  }
}

export async function buildDownloadUrl(storageKey: string, requestOrigin?: string): Promise<string> {
  if (USE_IN_MEMORY) {
    return `https://in-memory.invalid/${encodeURIComponent(storageKey)}`;
  }
  const cmd = new GetObjectCommand({
    Bucket: PLAIN_BUCKET,
    Key: storageKey,
    // Plain attachments are user-controlled bytes served from the app origin.
    // Force a download disposition so a malicious HTML/SVG upload cannot be
    // rendered as an executable document on the app origin (see AUDIT.md C5).
    ResponseContentDisposition: "attachment",
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn: PRESIGNED_DOWNLOAD_TTL_SEC });
  return rewriteS3Url(url, requestOrigin);
}

interface PlainAttachmentRow {
  id: string;
  storage_key: string;
  content_type: string;
  file_name: string | null;
  encrypted_size: string;
  upload_state: string;
  uploader_user_id: string;
}

export async function plainAttachmentRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    "/init",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;

      const limited = await consumeFixedWindowRateLimit({
        key: `plain_upload:${userId}`,
        max: UPLOAD_RATE_MAX,
        windowSec: UPLOAD_RATE_WINDOW_SEC,
      });
      if (!limited.allowed) {
        return reply.code(429).send({ error: "Upload rate limit exceeded" });
      }

      const body = parseOrReply(reply, InitPlainUploadRequestSchema, request.body);
      if (!body) return;

      if (body.size > config.MAX_ATTACHMENT_BYTES) {
        return reply.code(413).send({ error: "File too large" });
      }

      const storageKey = `plain/${randomUUID()}`;
      const attachmentId = randomUUID();

      await query(
        `INSERT INTO plain_attachments
           (id, uploader_user_id, storage_key, encrypted_size, content_type, file_name, upload_state)
         VALUES ($1, $2, $3, $4, $5, $6, 'initialized')`,
        [attachmentId, userId, storageKey, body.size, body.contentType, body.fileName ?? null]
      );

      const expiresAt = new Date(Date.now() + PRESIGNED_UPLOAD_TTL_SEC * 1000).toISOString();

      if (USE_IN_MEMORY) {
        return reply.code(200).send({
          attachmentId,
          uploadUrl: `https://in-memory.invalid/${encodeURIComponent(storageKey)}`,
          uploadFields: {},
          expiresAt,
        });
      }

      await ensureBucket();

      const { url, fields } = await createPresignedPost(s3, {
        Bucket: PLAIN_BUCKET,
        Key: storageKey,
        Conditions: [
          ["content-length-range", 1, config.MAX_ATTACHMENT_BYTES],
          ["eq", "$Content-Type", body.contentType],
        ],
        Fields: { "Content-Type": body.contentType },
        Expires: PRESIGNED_UPLOAD_TTL_SEC,
      });

      return reply.code(200).send({
        attachmentId,
        uploadUrl: rewriteS3Url(url, resolveBrowserOrigin(request.headers)),
        uploadFields: fields,
        expiresAt,
      });
    }
  );

  fastify.post(
    "/:id/confirm",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { id } = request.params as { id: string };

      const [att] = await query<PlainAttachmentRow>(
        `SELECT id, storage_key, content_type, file_name, encrypted_size, upload_state, uploader_user_id
         FROM plain_attachments WHERE id = $1`,
        [id]
      );

      if (!att) return reply.code(404).send({ error: "Attachment not found" });
      if (att.uploader_user_id !== userId) return reply.code(403).send({ error: "Forbidden" });
      if (att.upload_state === "verified") {
        const downloadUrl = await buildDownloadUrl(att.storage_key, resolveBrowserOrigin(request.headers));
        return reply.code(200).send({ attachmentId: att.id, downloadUrl });
      }
      if (att.upload_state !== "initialized" && att.upload_state !== "uploaded") {
        return reply.code(409).send({ error: "Attachment in unexpected state" });
      }

      if (!USE_IN_MEMORY) {
        try {
          await s3.send(new HeadObjectCommand({ Bucket: PLAIN_BUCKET, Key: att.storage_key }));
        } catch {
          return reply.code(422).send({ error: "Object not found in storage — upload first" });
        }
      } else {
        if (!inMemoryObjects.has(att.storage_key)) {
          inMemoryObjects.set(att.storage_key, Buffer.alloc(0));
        }
      }

      await query(
        `UPDATE plain_attachments SET upload_state = 'verified' WHERE id = $1`,
        [id]
      );

      const downloadUrl = await buildDownloadUrl(att.storage_key, resolveBrowserOrigin(request.headers));
      return reply.code(200).send({ attachmentId: att.id, downloadUrl });
    }
  );

  fastify.get(
    "/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { id } = request.params as { id: string };

      // Authorize: requester must be the uploader, the DM peer of any
      // message referencing this attachment, or an active member of any
      // group whose messages reference it. Returning 404 for unauthorized
      // requests avoids leaking attachment existence.
      const [att] = await query<{
        id: string;
        storage_key: string;
        upload_state: string;
        authorized: boolean;
      }>(
        `SELECT
           pa.id,
           pa.storage_key,
           pa.upload_state,
           (
             pa.uploader_user_id = $2
             OR EXISTS (
               SELECT 1 FROM plain_messages pm
               WHERE pm.attachment_id = pa.id
                 AND pm.deleted_at IS NULL
                 AND (
                   pm.sender_user_id = $2
                   OR pm.recipient_user_id = $2
                   OR (
                     pm.group_id IS NOT NULL
                     AND EXISTS (
                       SELECT 1 FROM plain_group_members pgm
                       WHERE pgm.group_id = pm.group_id
                         AND pgm.user_id = $2
                         AND pgm.removed_at IS NULL
                     )
                   )
                 )
             )
           ) AS authorized
         FROM plain_attachments pa
         WHERE pa.id = $1 AND pa.deleted_at IS NULL`,
        [id, userId]
      );

      if (!att || att.upload_state !== "verified" || !att.authorized) {
        return reply.code(404).send({ error: "Attachment not found" });
      }

      const downloadUrl = await buildDownloadUrl(att.storage_key, resolveBrowserOrigin(request.headers));
      return reply.code(200).send({ attachmentId: att.id, downloadUrl });
    }
  );

  /**
   * Cancel an upload that hasn't been confirmed yet — clears the row immediately
   * instead of waiting for the retention sweep. Allowed only by the original
   * uploader and only while the row is still in `initialized` or `uploaded`
   * state. Verified rows are owned by their referencing messages and must be
   * cleaned up via message deletion.
   */
  fastify.delete(
    "/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { id } = request.params as { id: string };

      const [att] = await query<{
        id: string;
        storage_key: string;
        uploader_user_id: string;
        upload_state: string;
        deleted_at: string | null;
      }>(
        `SELECT id, storage_key, uploader_user_id, upload_state, deleted_at
         FROM plain_attachments WHERE id = $1`,
        [id]
      );

      if (!att || att.deleted_at) {
        return reply.code(404).send({ error: "Attachment not found" });
      }
      if (att.uploader_user_id !== userId) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (att.upload_state !== "initialized" && att.upload_state !== "uploaded") {
        return reply.code(409).send({ error: "Cannot cancel a verified attachment" });
      }

      // Best-effort S3 cleanup. If the object isn't there yet (presigned POST
      // never completed) the delete silently succeeds; any other failure is
      // logged but doesn't block the row soft-delete — the retention purge
      // will retry the object delete on the next sweep.
      if (!USE_IN_MEMORY) {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: PLAIN_BUCKET, Key: att.storage_key }));
        } catch (err) {
          request.log.warn({ err, attachmentId: id }, "plain attachment cancel: S3 delete failed (will retry on retention sweep)");
        }
      } else {
        inMemoryObjects.delete(att.storage_key);
      }

      await query(
        `UPDATE plain_attachments SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
        [id]
      );

      return reply.code(204).send();
    }
  );
}
