/**
 * Attachment upload/download.
 * Client MUST encrypt the file before uploading — server stores only ciphertext.
 */
import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import {
  S3Client,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { requireAuth } from "../../middleware/auth.js";
import { query } from "../../db/pool.js";
import { config } from "../../config.js";
import { parseOrReply } from "../../utils/validation.js";
import { consumeFixedWindowRateLimit } from "../../utils/fixed-window-rate-limit.js";
import { resolveBrowserOrigin } from "../../utils/request-origin.js";
import { recordAttachmentEvent } from "../../services/observability.js";
import { z } from "zod";

/** 10 attachment uploads per user per minute. */
const UPLOAD_RATE_MAX = 10;
const UPLOAD_RATE_WINDOW_SEC = 60;

const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  },
  forcePathStyle: true, // required for MinIO
});

const InitUploadSchema = z.object({
  /** Encrypted file size in bytes */
  encryptedSize: z.number().int().positive().max(config.MAX_ATTACHMENT_BYTES),
  /** SHA-256 digest of encrypted blob (base64url) */
  encryptedDigest: z.string().min(43).max(44),
  /** MIME type of the ORIGINAL plaintext (for rendering hints only) */
  contentType: z.string().max(128),
});

const INLINE_CIPHERTEXT_MAX_BYTES = 16 * 1024 * 1024;
const USE_IN_MEMORY_ATTACHMENT_STORAGE = process.env["QM_API_TEST_USE_IN_MEMORY_SERVICES"] === "1";
const inMemoryAttachmentObjects = new Map<string, Buffer>();
type AttachmentUploadState = "initialized" | "uploaded" | "verified" | "failed" | "expired";

interface AttachmentRow {
  storage_key: string;
  encrypted_digest: string;
  content_type: string;
  encrypted_size: string;
  upload_state: AttachmentUploadState;
  uploader_device_id?: string;
}

interface AttachmentStorageState {
  ready: boolean;
  initializing: Promise<boolean> | null;
}

function buildInMemoryAttachmentUrl(storageKey: string): string {
  return `https://in-memory.invalid/${encodeURIComponent(storageKey)}`;
}

/**
 * Rewrites an S3/MinIO presigned URL to use the public-facing URL origin.
 *
 * In dev the API reaches MinIO via an internal HTTP address (e.g.
 * http://127.0.0.1:59000), but the browser must use an HTTPS URL that goes
 * through the Vite dev-server proxy.  S3_PUBLIC_URL overrides just the origin
 * (protocol + host) while preserving the path and query string so existing
 * presigned signatures remain valid.
 */
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

async function getAuthorizedAttachmentById(
  attachmentId: string,
  requesterUserId: string,
  requesterDeviceId: string
): Promise<AttachmentRow | null> {
  const rows = await query<AttachmentRow>(
    `SELECT a.storage_key, a.encrypted_digest, a.content_type, a.encrypted_size, a.upload_state
     FROM attachments a
     JOIN devices uploader ON uploader.id = a.uploader_device_id
     WHERE a.id = $1
       AND a.deleted_at IS NULL
       AND (
         uploader.user_id = $2
         OR EXISTS (
           SELECT 1
           FROM attachment_access aa
           WHERE aa.attachment_id = a.id
             AND aa.device_id = $3
         )
       )`,
    [attachmentId, requesterUserId, requesterDeviceId]
  );
  return rows[0] ?? null;
}

async function ensureAttachmentBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
    return;
  } catch (err) {
    const code = (err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } }).Code
      ?? (err as { name?: string }).name
      ?? "";
    const httpStatus = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const missingBucket = code === "NotFound" || code === "NoSuchBucket" || httpStatus === 404;
    if (!missingBucket) throw err;
  }

  try {
    await s3.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET }));
  } catch (err) {
    const code = (err as { name?: string; Code?: string }).Code
      ?? (err as { name?: string }).name
      ?? "";
    if (code === "BucketAlreadyOwnedByYou" || code === "BucketAlreadyExists") {
      return;
    }
    throw err;
  }
}

function isMissingAttachmentObjectError(error: unknown): boolean {
  const code =
    (error as { name?: string; code?: string; Code?: string }).Code ??
    (error as { name?: string; code?: string; Code?: string }).code ??
    (error as { name?: string; code?: string; Code?: string }).name;
  return code === "NoSuchKey" || code === "NotFound";
}

async function fetchAttachmentObjectBytes(storageKey: string): Promise<Uint8Array | null> {
  if (USE_IN_MEMORY_ATTACHMENT_STORAGE) {
    return inMemoryAttachmentObjects.get(storageKey) ?? null;
  }

  let object;
  try {
    object = await s3.send(
      new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: storageKey })
    );
  } catch (error) {
    if (isMissingAttachmentObjectError(error)) {
      return null;
    }
    throw error;
  }

  const body = object.Body;
  if (!body) {
    return null;
  }
  return body instanceof Uint8Array
    ? body
    : new Uint8Array(await body.transformToByteArray());
}

/**
 * Hash an attachment object without buffering it in memory.
 *
 * `MAX_ATTACHMENT_BYTES` defaults to 100 MiB; loading whole blobs to hash them
 * let concurrent verifications exhaust the heap (AUDIT.md H3). This streams the
 * S3 body into a running SHA-256 instead. Reading stops once the object exceeds
 * the configured maximum — the caller's size check then rejects it.
 */
async function hashAttachmentObjectStream(
  storageKey: string
): Promise<{ size: number; digest: string } | null> {
  if (USE_IN_MEMORY_ATTACHMENT_STORAGE) {
    const bytes = inMemoryAttachmentObjects.get(storageKey);
    if (!bytes) return null;
    return {
      size: bytes.byteLength,
      digest: createHash("sha256").update(bytes).digest("base64url"),
    };
  }

  let object;
  try {
    object = await s3.send(
      new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: storageKey })
    );
  } catch (error) {
    if (isMissingAttachmentObjectError(error)) {
      return null;
    }
    throw error;
  }

  const body = object.Body;
  if (!body) {
    return null;
  }

  const hash = createHash("sha256");
  let size = 0;

  if (typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      hash.update(buf);
      if (size > config.MAX_ATTACHMENT_BYTES) {
        return { size, digest: hash.digest("base64url") };
      }
    }
  } else {
    const bytes = new Uint8Array(await body.transformToByteArray());
    size = bytes.byteLength;
    hash.update(bytes);
  }

  return { size, digest: hash.digest("base64url") };
}

async function verifyAttachmentObject(
  attachmentId: string,
  att: AttachmentRow
): Promise<{ ok: true } | { ok: false; status: number; error: string; markFailed?: boolean }> {
  const expectedSize = Number.parseInt(att.encrypted_size, 10);
  const hashed = await hashAttachmentObjectStream(att.storage_key);
  if (!hashed) {
    return { ok: false, status: 409, error: "Attachment object not ready" };
  }
  await query(
    `UPDATE attachments
     SET upload_state = 'uploaded',
         uploaded_at = COALESCE(uploaded_at, now())
     WHERE id = $1
       AND upload_state IN ('initialized', 'uploaded')`,
    [attachmentId]
  );
  if (hashed.size !== expectedSize) {
    return {
      ok: false,
      status: 400,
      error: "Encrypted size mismatch",
      markFailed: true,
    };
  }

  if (hashed.digest !== att.encrypted_digest) {
    return {
      ok: false,
      status: 400,
      error: "Encrypted digest mismatch",
      markFailed: true,
    };
  }

  await query(
    `UPDATE attachments
     SET upload_state = 'verified',
         uploaded_at = COALESCE(uploaded_at, now()),
         verified_at = now(),
         failed_at = NULL,
         upload_failure_reason = NULL
     WHERE id = $1`,
    [attachmentId]
  );

  return { ok: true };
}

async function markAttachmentUploadFailed(
  attachmentId: string,
  reason: string
): Promise<void> {
  await query(
    `UPDATE attachments
     SET upload_state = 'failed',
         failed_at = now(),
         upload_failure_reason = $2
     WHERE id = $1
       AND upload_state <> 'verified'`,
    [attachmentId, reason]
  );
}

export async function attachmentRoutes(fastify: FastifyInstance): Promise<void> {
  const storageState: AttachmentStorageState = {
    ready: false,
    initializing: null,
  };

  const ensureAttachmentStorageReady = async (): Promise<boolean> => {
    if (storageState.ready) return true;
    if (storageState.initializing) {
      return storageState.initializing;
    }

    storageState.initializing = (async () => {
      if (USE_IN_MEMORY_ATTACHMENT_STORAGE) {
        storageState.ready = true;
        return true;
      }

      try {
        await ensureAttachmentBucket();
        storageState.ready = true;
        return true;
      } catch (error) {
        storageState.ready = false;
        fastify.log.warn(
          { err: error },
          "Attachment storage is unavailable; attachment routes will return 503 until storage recovers"
        );
        return false;
      } finally {
        storageState.initializing = null;
      }
    })();

    return storageState.initializing;
  };

  const sendAttachmentStorageUnavailable = (reply: {
    code: (statusCode: number) => { send: (payload: unknown) => unknown };
  }) => {
    // Do not echo the raw storage error to clients — it can contain bucket
    // names, endpoint URLs, or credential hints. The detail stays in
    // storageState.lastError and the server log for operators.
    return reply.code(503).send({
      error: "Attachment storage unavailable",
    });
  };

  void ensureAttachmentStorageReady();

  // Returns a pre-signed S3 POST URL valid for 15 minutes.
  fastify.post(
    "/init-upload",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!(await ensureAttachmentStorageReady())) {
        return sendAttachmentStorageUnavailable(reply);
      }

      const body = parseOrReply(reply, InitUploadSchema, request.body);
      if (!body) return;

      const uploadLimit = await consumeFixedWindowRateLimit({
        key: `rl:upload:${request.auth.sub}`,
        max: UPLOAD_RATE_MAX,
        windowSec: UPLOAD_RATE_WINDOW_SEC,
      });
      if (!uploadLimit.allowed) {
        return reply
          .code(429)
          .header("Retry-After", String(uploadLimit.retryAfterSec))
          .send({ error: "Too many requests" });
      }

      const { deviceId } = request.auth;
      const attachmentId = randomUUID();
      const storageKey = `attachments/${attachmentId}`;

      const uploadTarget = USE_IN_MEMORY_ATTACHMENT_STORAGE
        ? {
            url: buildInMemoryAttachmentUrl(storageKey),
            fields: {},
          }
        : await createPresignedPost(s3, {
            Bucket: config.S3_BUCKET,
            Key: storageKey,
            Conditions: [["content-length-range", 1, config.MAX_ATTACHMENT_BYTES]],
            Expires: 900, // 15 minutes
          });

      await query(
        `INSERT INTO attachments
           (id, uploader_device_id, storage_key, encrypted_size, encrypted_digest, content_type)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          attachmentId,
          deviceId,
          storageKey,
          body.encryptedSize,
          body.encryptedDigest,
          body.contentType,
        ]
      );

      recordAttachmentEvent("uploaded");
      return { attachmentId, uploadUrl: rewriteS3Url(uploadTarget.url, resolveBrowserOrigin(request.headers)), fields: uploadTarget.fields };
    }
  );

  fastify.get<{ Params: { attachmentId: string } }>(
    "/:attachmentId/download-url",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!(await ensureAttachmentStorageReady())) {
        return sendAttachmentStorageUnavailable(reply);
      }

      const { attachmentId } = request.params;
      const { sub: requesterUserId, deviceId: requesterDeviceId } = request.auth;
      const att = await getAuthorizedAttachmentById(attachmentId, requesterUserId, requesterDeviceId);
      if (!att) {
        return reply.code(404).send({ error: "Attachment not found" });
      }
      if (att.upload_state !== "verified") {
        return reply.code(409).send({ error: "Attachment object not ready" });
      }
      const downloadUrl = USE_IN_MEMORY_ATTACHMENT_STORAGE
        ? buildInMemoryAttachmentUrl(att.storage_key)
        : await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: att.storage_key }),
            { expiresIn: 3600 } // 1 hour
          );

      recordAttachmentEvent("downloaded");
      return {
        downloadUrl: rewriteS3Url(downloadUrl, resolveBrowserOrigin(request.headers)),
        encryptedDigest: att.encrypted_digest,
        contentType: att.content_type,
        encryptedSize: Number.parseInt(att.encrypted_size, 10),
      };
    }
  );

  // Fallback for clients that cannot reach MinIO directly (mobile/CORS/LAN issues).
  fastify.post<{ Params: { attachmentId: string } }>(
    "/:attachmentId/upload-ciphertext",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!(await ensureAttachmentStorageReady())) {
        return sendAttachmentStorageUnavailable(reply);
      }

      const { attachmentId } = request.params;
      const { deviceId } = request.auth;
      const attRows = await query<AttachmentRow & { uploader_device_id: string }>(
        `SELECT storage_key, encrypted_digest, content_type, encrypted_size,
                upload_state, uploader_device_id
         FROM attachments
         WHERE id = $1 AND deleted_at IS NULL`,
        [attachmentId]
      );
      const att = attRows[0];
      if (!att) {
        return reply.code(404).send({ error: "Attachment not found" });
      }
      if (att.uploader_device_id !== deviceId) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (att.upload_state === "verified") {
        return reply.code(204).send();
      }
      if (att.upload_state === "failed" || att.upload_state === "expired") {
        return reply.code(409).send({ error: "Attachment upload is not usable" });
      }

      const file = await request.file();
      if (!file) {
        return reply.code(400).send({ error: "Missing ciphertext file" });
      }

      const tempFilePath = join(tmpdir(), `qm-attachment-${attachmentId}-${randomUUID()}.bin`);
      let totalBytes = 0;
      const digestHash = createHash("sha256");
      const enforceLimit = new Transform({
        transform(chunk, _encoding, callback) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buf.length;
          if (totalBytes > config.MAX_ATTACHMENT_BYTES) {
            callback(Object.assign(new Error("Attachment too large"), { code: "ATTACHMENT_TOO_LARGE" }));
            return;
          }
          digestHash.update(buf);
          callback(null, buf);
        },
      });

      try {
        try {
          await pipeline(
            file.file,
            enforceLimit,
            createWriteStream(tempFilePath, { flags: "wx" })
          );
        } catch (error) {
          if ((error as { code?: string }).code === "ATTACHMENT_TOO_LARGE") {
            await markAttachmentUploadFailed(attachmentId, "Attachment too large");
            return reply.code(413).send({ error: "Attachment too large" });
          }
          throw error;
        }

        const expectedSize = Number.parseInt(att.encrypted_size, 10);
        if (totalBytes !== expectedSize) {
          await markAttachmentUploadFailed(attachmentId, "Encrypted size mismatch");
          return reply.code(400).send({ error: "Encrypted size mismatch" });
        }

        const digest = digestHash.digest("base64url");
        if (digest !== att.encrypted_digest) {
          await markAttachmentUploadFailed(attachmentId, "Encrypted digest mismatch");
          return reply.code(400).send({ error: "Encrypted digest mismatch" });
        }

        if (USE_IN_MEMORY_ATTACHMENT_STORAGE) {
          inMemoryAttachmentObjects.set(att.storage_key, await readFile(tempFilePath));
        } else {
          await s3.send(
            new PutObjectCommand({
              Bucket: config.S3_BUCKET,
              Key: att.storage_key,
              Body: createReadStream(tempFilePath),
              ContentType: "application/octet-stream",
              ContentLength: totalBytes,
            })
          );
        }

        await query(
          `UPDATE attachments
           SET upload_state = 'verified',
               uploaded_at = COALESCE(uploaded_at, now()),
               verified_at = now(),
               failed_at = NULL,
               upload_failure_reason = NULL
           WHERE id = $1`,
          [attachmentId]
        );

        return reply.code(204).send();
      } finally {
        await unlink(tempFilePath).catch(() => undefined);
      }
    }
  );

  fastify.post<{ Params: { attachmentId: string } }>(
    "/:attachmentId/complete",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!(await ensureAttachmentStorageReady())) {
        return sendAttachmentStorageUnavailable(reply);
      }

      const { attachmentId } = request.params;
      const { deviceId } = request.auth;
      const attRows = await query<AttachmentRow & { uploader_device_id: string }>(
        `SELECT storage_key, encrypted_digest, content_type, encrypted_size,
                upload_state, uploader_device_id
         FROM attachments
         WHERE id = $1 AND deleted_at IS NULL`,
        [attachmentId]
      );
      const att = attRows[0];
      if (!att) {
        return reply.code(404).send({ error: "Attachment not found" });
      }
      if (att.uploader_device_id !== deviceId) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (att.upload_state === "verified") {
        return reply.code(204).send();
      }
      if (att.upload_state === "failed" || att.upload_state === "expired") {
        return reply.code(409).send({ error: "Attachment upload is not usable" });
      }

      const verification = await verifyAttachmentObject(attachmentId, att);
      if (!verification.ok) {
        if (verification.markFailed) {
          await markAttachmentUploadFailed(attachmentId, verification.error);
        }
        return reply.code(verification.status).send({ error: verification.error });
      }

      return reply.code(204).send();
    }
  );

  // Same-origin fallback for browser clients (avoids direct MinIO CORS/host issues).
  fastify.get<{ Params: { attachmentId: string } }>(
    "/:attachmentId/ciphertext",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!(await ensureAttachmentStorageReady())) {
        return sendAttachmentStorageUnavailable(reply);
      }

      const { attachmentId } = request.params;
      const { sub: requesterUserId, deviceId: requesterDeviceId } = request.auth;
      const att = await getAuthorizedAttachmentById(attachmentId, requesterUserId, requesterDeviceId);
      if (!att) {
        return reply.code(404).send({ error: "Attachment not found" });
      }
      if (att.upload_state !== "verified") {
        return reply.code(409).send({ error: "Attachment object not ready" });
      }

      const encryptedSize = Number.parseInt(att.encrypted_size, 10);
      if (encryptedSize > INLINE_CIPHERTEXT_MAX_BYTES) {
        return reply.code(413).send({ error: "Attachment too large for inline ciphertext transfer" });
      }

      const bytes = await fetchAttachmentObjectBytes(att.storage_key);
      if (!bytes) {
        return reply.code(409).send({ error: "Attachment object not ready" });
      }

      return {
        ciphertext: Buffer.from(bytes).toString("base64url"),
        encryptedDigest: att.encrypted_digest,
        contentType: att.content_type,
        encryptedSize,
      };
    }
  );
}
