import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { requireAuth } from "../../middleware/auth.js";
import { query, transaction } from "../../db/pool.js";
import { publishMessage, redis } from "../../services/redis.js";
import { invalidateAuthSessionCacheMany } from "../../services/auth-session.js";
import {
  ensureDirectRelationship,
  resolveUserRelationshipAccess,
} from "../../services/user-relationships.js";
import { hasActiveConnectionForUserAcrossCluster } from "../../services/websocket.js";
import { consumeFixedWindowRateLimit } from "../../utils/fixed-window-rate-limit.js";
import { parseVersionedOrReply } from "../../utils/validation.js";
import {
  DEVICES_PROTOCOL_VERSION,
  DeviceListResponseSchema,
  UserDeviceDirectoryResponseSchema,
  UserPresenceResponseSchema,
  PreKeyBundleSchema,
  ReplenishPreKeysRequestSchema,
  RotateSignedPreKeyRequestSchema,
  UpdateCurrentDeviceCryptoMaterialRequestSchema,
  UserSearchResponseSchema,
} from "@seclettr/protocol";

const OTK_LOW_THRESHOLD = 20;
const OTK_RESERVATION_TTL_SECONDS = 10 * 60;
const USER_DEVICE_METADATA_WINDOW_SEC = 60;
const USER_DEVICE_METADATA_MAX_PER_TARGET = 60;
const USER_DEVICE_METADATA_RATE_LIMIT_PREFIX = "rate:user-devices:v1:";
const USER_SEARCH_WINDOW_SEC = 60;
const USER_SEARCH_MAX_PER_USER = 30;
const USER_SEARCH_RATE_LIMIT_PREFIX = "rate:user-search:v1:";
const USER_PREKEY_BUNDLE_WINDOW_SEC = 60;
const USER_PREKEY_BUNDLE_MAX_PER_TARGET = 12;
const USER_PREKEY_BUNDLE_RATE_LIMIT_PREFIX = "rate:user-prekey-bundle:v1:";
const DIRECT_RELATIONSHIP_WINDOW_SEC = 60 * 60;
const DIRECT_RELATIONSHIP_MAX_PER_USER = 30;
const DIRECT_RELATIONSHIP_RATE_LIMIT_PREFIX = "rate:user-direct-relationship:v1:";
const OTK_MIN_RESERVED = 5;
const CONTACT_GRANT_HEADER = "x-seclettr-contact-grant";
const CONTACT_GRANT_TTL_SECONDS = 10 * 60;

interface ContactGrantPayload {
  sub: string;
  targetUserId: string;
  tokenUse: "contact";
  purpose: "first_contact_metadata";
  iat: number;
  exp: number;
}

type UserMetadataAccessBasis =
  | "self"
  | "direct_relationship"
  | "shared_group"
  | "prior_direct_message"
  | "prior_plain_direct_message"
  | "shared_plain_group"
  | "active_direct_call"
  | "contact_grant"
  | "none";

function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readSingleHeaderValue(
  value: string | string[] | undefined
): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const first = value.find(
      (candidate) =>
        typeof candidate === "string" && candidate.trim().length > 0
    );
    return first ? first.trim() : null;
  }
  return null;
}

function toIsoString(
  value: string | Date | null | undefined
): string | undefined {
  if (!value) {
    return undefined;
  }
  return value instanceof Date ? value.toISOString() : value;
}

async function verifyContactGrant(
  fastify: FastifyInstance,
  request: FastifyRequest,
  targetUserId: string
): Promise<boolean> {
  const rawGrant = readSingleHeaderValue(
    request.headers[CONTACT_GRANT_HEADER]
  );
  if (!rawGrant) {
    return false;
  }

  try {
    const payload = fastify.jwt.verify<ContactGrantPayload>(rawGrant);
    return (
      payload.tokenUse === "contact" &&
      payload.purpose === "first_contact_metadata" &&
      payload.sub === request.auth.sub &&
      payload.targetUserId === targetUserId
    );
  } catch {
    return false;
  }
}

async function resolveMetadataAccess(
  fastify: FastifyInstance,
  request: FastifyRequest,
  targetUserId: string,
  options?: { allowContactGrant?: boolean }
): Promise<{
  allowed: boolean;
  basis: UserMetadataAccessBasis;
}> {
  if (request.auth.sub === targetUserId) {
    return {
      allowed: true,
      basis: "self",
    };
  }

  const relationship = await resolveUserRelationshipAccess(
    request.auth.sub,
    targetUserId
  );
  if (relationship.allowed) {
    return relationship;
  }

  if (options?.allowContactGrant) {
    const contactGrantAllowed = await verifyContactGrant(
      fastify,
      request,
      targetUserId
    );
    if (contactGrantAllowed) {
      return {
        allowed: true,
        basis: "contact_grant",
      };
    }
  }

  return {
    allowed: false,
    basis: "none",
  };
}

async function enforceUserDeviceMetadataLookupLimit(
  requesterUserId: string,
  targetUserId: string
): Promise<{ allowed: true } | { allowed: false; retryAfterSec: number }> {
  const key = `${USER_DEVICE_METADATA_RATE_LIMIT_PREFIX}${requesterUserId}:${targetUserId}`;
  const count = await redis.incr(key);

  let ttl = await redis.ttl(key);
  if (count === 1 || ttl < 0) {
    await redis.expire(key, USER_DEVICE_METADATA_WINDOW_SEC);
    ttl = USER_DEVICE_METADATA_WINDOW_SEC;
  }

  if (count > USER_DEVICE_METADATA_MAX_PER_TARGET) {
    return {
      allowed: false,
      retryAfterSec: ttl > 0 ? ttl : USER_DEVICE_METADATA_WINDOW_SEC,
    };
  }

  return {
    allowed: true,
  };
}

async function enforceUserSearchRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const requesterUserId = request.auth?.sub;
  if (!requesterUserId) return;

  const limit = await consumeFixedWindowRateLimit({
    key: `${USER_SEARCH_RATE_LIMIT_PREFIX}${requesterUserId}`,
    max: USER_SEARCH_MAX_PER_USER,
    windowSec: USER_SEARCH_WINDOW_SEC,
  });

  if (limit.allowed) return;

  reply.header("Retry-After", String(limit.retryAfterSec));
  void reply.code(429).send({ error: "Too many user search requests" });
}

async function enforcePreKeyBundleLookupLimit(
  requesterUserId: string,
  targetDeviceId: string
): Promise<{ allowed: true } | { allowed: false; retryAfterSec: number }> {
  const limit = await consumeFixedWindowRateLimit({
    key: `${USER_PREKEY_BUNDLE_RATE_LIMIT_PREFIX}${requesterUserId}:${targetDeviceId}`,
    max: USER_PREKEY_BUNDLE_MAX_PER_TARGET,
    windowSec: USER_PREKEY_BUNDLE_WINDOW_SEC,
  });

  if (limit.allowed) {
    return { allowed: true };
  }

  return {
    allowed: false,
    retryAfterSec: limit.retryAfterSec,
  };
}

async function enforceDirectRelationshipCreateRateLimit(
  requesterUserId: string,
  reply: FastifyReply
): Promise<boolean> {
  const limit = await consumeFixedWindowRateLimit({
    key: `${DIRECT_RELATIONSHIP_RATE_LIMIT_PREFIX}${requesterUserId}`,
    max: DIRECT_RELATIONSHIP_MAX_PER_USER,
    windowSec: DIRECT_RELATIONSHIP_WINDOW_SEC,
  });

  if (limit.allowed) {
    return true;
  }

  reply.header("Retry-After", String(limit.retryAfterSec));
  void reply.code(429).send({ error: "Too many direct relationship requests" });
  return false;
}

export async function deviceRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    "/",
    { preHandler: requireAuth },
    async (request) => {
      const { sub: userId } = request.auth;
      const devices = await query<{
        id: string;
        name: string;
        identity_key_public: string;
        signing_key_public: string;
        registration_id: number;
        created_at: string;
        last_seen_at: string | null;
      }>(
        `SELECT id, name, identity_key_public, signing_key_public,
                registration_id, created_at, last_seen_at
         FROM devices WHERE user_id = $1 ORDER BY created_at ASC`,
        [userId]
      );

      return DeviceListResponseSchema.parse({
        version: DEVICES_PROTOCOL_VERSION,
        devices: devices.map(d => ({
          deviceId: d.id,
          name: d.name,
          identityKeyPublic: d.identity_key_public,
          signingKeyPublic: d.signing_key_public,
          registrationId: d.registration_id,
          createdAt: toIsoString(d.created_at)!,
          lastSeenAt: toIsoString(d.last_seen_at),
        })),
      });
    }
  );

  fastify.put(
    "/crypto-material",
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = parseVersionedOrReply(
        reply,
        UpdateCurrentDeviceCryptoMaterialRequestSchema,
        request.body,
        DEVICES_PROTOCOL_VERSION
      );
      if (!body) return;

      const { sub: userId, deviceId } = request.auth;
      const updated = await transaction(async (client) => {
        const deviceRows = await client.query<{ id: string }>(
          `UPDATE devices
           SET identity_key_public = $1,
               signing_key_public = $2,
               last_seen_at = now()
           WHERE id = $3
             AND user_id = $4
           RETURNING id`,
          [body.identityKeyPublic, body.signingKeyPublic, deviceId, userId]
        );

        if ((deviceRows.rowCount ?? 0) === 0) {
          return null;
        }

        await client.query(
          "DELETE FROM signed_prekeys WHERE device_id = $1",
          [deviceId]
        );
        await client.query(
          `INSERT INTO signed_prekeys (device_id, key_id, public_key, signature)
           VALUES ($1, $2, $3, $4)`,
          [
            deviceId,
            body.signedPreKey.id,
            body.signedPreKey.publicKey,
            body.signedPreKey.signature,
          ]
        );

        return deviceRows.rows[0]!;
      });

      if (!updated) {
        return reply.code(404).send({ error: "Device not found" });
      }

      return reply.code(204).send();
    }
  );

  fastify.delete<{ Params: { deviceId: string } }>(
    "/:deviceId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: userId } = request.auth;
      const { deviceId } = request.params;

      if (deviceId === request.auth.deviceId) {
        return reply.code(400).send({ error: "Cannot revoke the current device" });
      }

      const sessionRows = await query<{ id: string }>(
        "SELECT id FROM auth_sessions WHERE device_id = $1",
        [deviceId]
      );

      const result = await query(
        "DELETE FROM devices WHERE id = $1 AND user_id = $2 RETURNING id",
        [deviceId, userId]
      );
      if (result.length === 0) {
        return reply.code(404).send({ error: "Device not found" });
      }
      // The device's auth_sessions are removed by ON DELETE CASCADE; drop any
      // cached liveness entries so its access tokens stop working immediately.
      await invalidateAuthSessionCacheMany(sessionRows.map((row) => row.id));
      return { ok: true };
    }
  );

  fastify.post(
    "/prekeys",
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = parseVersionedOrReply(
        reply,
        ReplenishPreKeysRequestSchema,
        request.body,
        DEVICES_PROTOCOL_VERSION
      );
      if (!body) return;
      const { deviceId } = request.auth;

      await transaction(async (client) => {
        await client.query(
          "DELETE FROM one_time_prekeys WHERE device_id = $1 AND used_at IS NULL",
          [deviceId]
        );

        if (body.oneTimePreKeys.length > 0) {
          const keyIds = body.oneTimePreKeys.map((otk) => otk.id);
          const publicKeys = body.oneTimePreKeys.map((otk) => otk.publicKey);
          await client.query(
            `INSERT INTO one_time_prekeys (device_id, key_id, public_key)
             SELECT $1, unnest($2::integer[]), unnest($3::text[])
             ON CONFLICT (device_id, key_id)
             DO UPDATE SET
               public_key = EXCLUDED.public_key,
               used_at = NULL,
               reserved_at = NULL,
               reservation_expires_at = NULL,
               reservation_token_hash = NULL,
               reserved_for_user_id = NULL,
               reserved_message_id = NULL,
               created_at = now()`,
            [deviceId, keyIds, publicKeys]
          );
        }
      });

      return reply.code(201).send({ ok: true });
    }
  );

  fastify.put(
    "/signed-prekey",
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = parseVersionedOrReply(
        reply,
        RotateSignedPreKeyRequestSchema,
        request.body,
        DEVICES_PROTOCOL_VERSION
      );
      if (!body) return;
      const { deviceId } = request.auth;

      await query(
        `INSERT INTO signed_prekeys (device_id, key_id, public_key, signature)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (device_id, key_id)
         DO UPDATE SET public_key = EXCLUDED.public_key, signature = EXCLUDED.signature`,
        [deviceId, body.signedPreKey.id, body.signedPreKey.publicKey, body.signedPreKey.signature]
      );

      return { ok: true };
    }
  );
}


export async function userRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    "/me",
    { preHandler: requireAuth },
    async (request) => {
      const { sub: userId } = request.auth;
      const rows = await query<{
        id: string;
        username: string;
        display_name: string | null;
        bio: string | null;
        avatar_key: string | null;
      }>(
        "SELECT id, username, display_name, bio, avatar_key FROM users WHERE id = $1",
        [userId]
      );
      if (rows.length === 0) throw new Error("User not found");
      const user = rows[0]!;
      return {
        version: DEVICES_PROTOCOL_VERSION,
        userId: user.id,
        username: user.username,
        displayName: user.display_name,
        bio: user.bio,
        avatarKey: user.avatar_key,
      };
    }
  );

  fastify.post<{ Params: { userId: string } }>(
    "/:userId/direct-relationship",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: requesterUserId } = request.auth;
      const { userId } = request.params;

      if (requesterUserId === userId) {
        return reply.code(400).send({ error: "Cannot create a direct relationship with yourself" });
      }

      if (!(await enforceDirectRelationshipCreateRateLimit(requesterUserId, reply))) {
        return;
      }

      const rows = await query<{ id: string }>(
        "SELECT id FROM users WHERE id = $1",
        [userId]
      );
      if (rows.length === 0) {
        return reply.code(404).send({ error: "User not found" });
      }

      await ensureDirectRelationship(requesterUserId, userId);
      return { ok: true };
    }
  );

  fastify.get<{ Params: { userId: string } }>(
    "/:userId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { userId } = request.params;

      const rows = await query<{ id: string; username: string }>(
        "SELECT id, username FROM users WHERE id = $1",
        [userId]
      );
      if (rows.length === 0) {
        return reply.code(404).send({ error: "User not found" });
      }

      const access = await resolveMetadataAccess(fastify, request, userId, {
        allowContactGrant: true,
      });
      if (!access.allowed) {
        return reply.code(403).send({ error: "Relationship or contact grant required" });
      }

      return {
        version: DEVICES_PROTOCOL_VERSION,
        userId: rows[0]!.id,
        username: rows[0]!.username,
      };
    }
  );

  fastify.get<{ Params: { userId: string } }>(
    "/:userId/devices",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: requesterUserId } = request.auth;
      const { userId } = request.params;

      const access = await resolveMetadataAccess(fastify, request, userId, {
        allowContactGrant: true,
      });
      if (!access.allowed) {
        return reply.code(403).send({ error: "Relationship or contact grant required" });
      }

      if (requesterUserId !== userId) {
        const limit = await enforceUserDeviceMetadataLookupLimit(requesterUserId, userId);
        if (!limit.allowed) {
          reply.header("Retry-After", String(limit.retryAfterSec));
          request.log.warn(
            {
              requesterUserId,
              targetUserId: userId,
              ip: request.ip,
            },
            "User device metadata lookup rate limit exceeded"
          );
          return reply.code(429).send({ error: "Too many device metadata requests" });
        }
      }

      const devices = await query<{
        id: string;
        name: string;
        identity_key_public: string;
        signing_key_public: string;
        registration_id: number;
        created_at: string;
        last_seen_at: string | null;
      }>(
        `SELECT id, name, identity_key_public, signing_key_public, registration_id, created_at, last_seen_at
         FROM devices
         WHERE user_id = $1
         ORDER BY created_at ASC`,
        [userId]
      );

      if (requesterUserId !== userId) {
        return UserDeviceDirectoryResponseSchema.parse({
          version: DEVICES_PROTOCOL_VERSION,
          devices: devices.map((device) => ({
            deviceId: device.id,
            identityKeyPublic: device.identity_key_public,
            signingKeyPublic: device.signing_key_public,
          })),
        });
      }

      return DeviceListResponseSchema.parse({
        version: DEVICES_PROTOCOL_VERSION,
        devices: devices.map(d => ({
          deviceId: d.id,
          name: d.name,
          identityKeyPublic: d.identity_key_public,
          signingKeyPublic: d.signing_key_public,
          registrationId: d.registration_id,
          createdAt: toIsoString(d.created_at)!,
          lastSeenAt: toIsoString(d.last_seen_at),
        })),
      });
    }
  );

  fastify.get<{ Params: { userId: string } }>(
    "/:userId/presence",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: requesterUserId } = request.auth;
      const { userId } = request.params;

      const users = await query<{ id: string }>(
        "SELECT id FROM users WHERE id = $1",
        [userId]
      );
      if (users.length === 0) {
        return reply.code(404).send({ error: "User not found" });
      }

      if (requesterUserId !== userId) {
        const relationship = await resolveMetadataAccess(
          fastify,
          request,
          userId
        );
        if (!relationship.allowed) {
          return reply.code(403).send({ error: "Relationship required" });
        }
      }

      const rows = await query<{ last_seen_at: string | null }>(
        `SELECT MAX(last_seen_at) AS last_seen_at
         FROM devices
         WHERE user_id = $1`,
        [userId]
      );

      return UserPresenceResponseSchema.parse({
        version: DEVICES_PROTOCOL_VERSION,
        userId,
        online: await hasActiveConnectionForUserAcrossCluster(userId),
        lastSeenAt: rows[0]?.last_seen_at
          ? new Date(rows[0].last_seen_at).toISOString()
          : undefined,
      });
    }
  );

  fastify.get<{ Params: { userId: string; deviceId: string } }>(
    "/:userId/devices/:deviceId/prekey-bundle",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { sub: requesterUserId } = request.auth;
      const { userId, deviceId } = request.params;

      if (requesterUserId !== userId) {
        const access = await resolveMetadataAccess(fastify, request, userId, {
          allowContactGrant: true,
        });
        if (!access.allowed) {
          return reply.code(403).send({ error: "Relationship or contact grant required" });
        }

        const limit = await enforcePreKeyBundleLookupLimit(requesterUserId, deviceId);
        if (!limit.allowed) {
          reply.header("Retry-After", String(limit.retryAfterSec));
          request.log.warn(
            {
              requesterUserId,
              targetUserId: userId,
              targetDeviceId: deviceId,
              ip: request.ip,
            },
            "Prekey bundle lookup rate limit exceeded"
          );
          return reply.code(429).send({ error: "Too many prekey bundle requests" });
        }
      }

      const result = await transaction(async (client) => {
        const devices = await client.query<{
          id: string;
          user_id: string;
          identity_key_public: string;
          signing_key_public: string;
          registration_id: number;
        }>(
          `SELECT id, user_id, identity_key_public, signing_key_public, registration_id
           FROM devices WHERE id = $1 AND user_id = $2`,
          [deviceId, userId]
        );

        if ((devices.rowCount ?? 0) === 0) {
          return { status: "device_not_found" as const };
        }
        const device = devices.rows[0]!;

        const spks = await client.query<{ key_id: number; public_key: string; signature: string }>(
          `SELECT key_id, public_key, signature
           FROM signed_prekeys WHERE device_id = $1
           ORDER BY created_at DESC LIMIT 1`,
          [deviceId]
        );
        if ((spks.rowCount ?? 0) === 0) {
          return { status: "signed_prekey_missing" as const };
        }
        const spk = spks.rows[0]!;

        const remainingRows = await client.query<{ count: string }>(
          `SELECT COUNT(*) AS count
           FROM one_time_prekeys
           WHERE device_id = $1
             AND used_at IS NULL
             AND reserved_message_id IS NULL
             AND (reservation_expires_at IS NULL OR reservation_expires_at <= now())`,
          [deviceId]
        );
        const remainingBeforeIssue = Number.parseInt(remainingRows.rows[0]?.count ?? "0", 10);

        let oneTimePreKey:
          | {
              id: number;
              publicKey: string;
              reservationToken: string;
            }
          | undefined;
        let otkCount = remainingBeforeIssue;

        if (remainingBeforeIssue > OTK_MIN_RESERVED) {
          const reservationToken = fastify.jwt.sign(
            {
              sub: requesterUserId,
              targetUserId: userId,
              tokenUse: "contact" as const,
              purpose: "first_contact_metadata" as const,
            },
            { expiresIn: `${CONTACT_GRANT_TTL_SECONDS}s` }
          );
          const reservationTokenHash = hashOpaqueToken(reservationToken);
          const otks = await client.query<{
            key_id: number;
            public_key: string;
            reservation_token_hash: string;
          }>(
            `WITH next_otk AS (
               SELECT id
               FROM one_time_prekeys
               WHERE device_id = $1
                 AND used_at IS NULL
                 AND reserved_message_id IS NULL
                 AND (reservation_expires_at IS NULL OR reservation_expires_at <= now())
               ORDER BY created_at DESC
               FOR UPDATE SKIP LOCKED
               LIMIT 1
             )
             UPDATE one_time_prekeys otk
             SET reserved_at = now(),
                 reservation_expires_at = now() + make_interval(secs => $3::int),
                 reservation_token_hash = $2,
                 reserved_for_user_id = $4,
                 reserved_message_id = NULL
             FROM next_otk
             WHERE otk.id = next_otk.id
             RETURNING otk.key_id, otk.public_key, otk.reservation_token_hash`,
            [
              deviceId,
              reservationTokenHash,
              OTK_RESERVATION_TTL_SECONDS,
              requesterUserId,
            ]
          );

          if ((otks.rowCount ?? 0) > 0) {
            oneTimePreKey = {
              id: otks.rows[0]!.key_id,
              publicKey: otks.rows[0]!.public_key,
              reservationToken,
            };
            otkCount = Math.max(remainingBeforeIssue - 1, 0);
          }
        }

        return {
          status: "ok" as const,
          device,
          spk,
          oneTimePreKey,
          otkCount,
        };
      });

      if (result.status === "device_not_found") {
        return reply.code(404).send({ error: "Device not found" });
      }
      if (result.status === "signed_prekey_missing") {
        return reply.code(404).send({ error: "No signed prekey" });
      }

      if (result.otkCount < OTK_LOW_THRESHOLD) {
        void publishMessage({
          type: "prekeys.low",
          recipientDeviceId: deviceId,
          remaining: result.otkCount,
        }).catch((err: unknown) => fastify.log.error({ err }, "Failed to publish prekeys.low"));
      }

      return PreKeyBundleSchema.parse({
        version: DEVICES_PROTOCOL_VERSION,
        userId: result.device.user_id,
        deviceId: result.device.id,
        registrationId: result.device.registration_id,
        identityKeyPublic: result.device.identity_key_public,
        signingKeyPublic: result.device.signing_key_public,
        signedPreKey: {
          id: result.spk.key_id,
          publicKey: result.spk.public_key,
          signature: result.spk.signature,
        },
        oneTimePreKey: result.oneTimePreKey,
        otkCount: result.otkCount,
      });
    }
  );

  fastify.get<{ Querystring: { q: string } }>(
    "/search",
    { preHandler: [requireAuth, enforceUserSearchRateLimit] },
    async (request) => {
      const { sub: requesterUserId } = request.auth;
      const q = (request.query.q ?? "").slice(0, 32);
      if (q.trim().length < 3) {
        return UserSearchResponseSchema.parse({
          version: DEVICES_PROTOCOL_VERSION,
          users: [],
        });
      }

      const users = await query<{ id: string; username: string }>(
        `SELECT id, username FROM users
         WHERE id != $2
           AND lower(username) = lower($1)
         ORDER BY username ASC
         LIMIT 1`,
        [q, requesterUserId]
      );
      const expiresAt = new Date(
        Date.now() + CONTACT_GRANT_TTL_SECONDS * 1000
      ).toISOString();
      return UserSearchResponseSchema.parse({
        version: DEVICES_PROTOCOL_VERSION,
        users: users.map((user) => ({
          userId: user.id,
          username: user.username,
          contactGrant: fastify.jwt.sign(
            {
              sub: requesterUserId,
              targetUserId: user.id,
              tokenUse: "contact" as const,
              purpose: "first_contact_metadata" as const,
            },
            { expiresIn: `${CONTACT_GRANT_TTL_SECONDS}s` }
          ),
          contactGrantExpiresAt: expiresAt,
        })),
      });
    }
  );
}
