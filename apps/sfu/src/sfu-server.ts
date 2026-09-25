import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import fastifyJwt from "@fastify/jwt";
import type * as mediasoup from "mediasoup";
import { nanoid } from "nanoid";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyInstance } from "fastify";
import { FixedWindowRateLimiter } from "./http-rate-limit.js";
import {
  SFU_PROTOCOL_VERSION,
  SfuCloseProducerRequestSchema,
  SfuCloseProducerResponseSchema,
  SfuConnectTransportRequestSchema,
  SfuConnectTransportResponseSchema,
  SfuConsumeRequestSchema,
  SfuConsumeResponseSchema,
  SfuCreateTransportRequestSchema,
  SfuCreateTransportResponseSchema,
  SfuProduceRequestSchema,
  SfuProduceResponseSchema,
  SfuRoomProducersResponseSchema,
  SfuRtpCapabilitiesResponseSchema,
  SfuResumeConsumerRequestSchema,
  SfuResumeConsumerResponseSchema,
} from "@seclettr/protocol";
import { normalizeSfuRtpParameters } from "./rtp-parameters.js";
import { parseVersionedOrReply } from "./validation.js";
import type { WorkerPool } from "./sfu-worker-pool.js";
import type { RoomAccessChecker } from "./sfu-room-access.js";
import { requireSfuAuth } from "./sfu-room-access.js";
import {
  attachConsumer,
  attachProducer,
  attachTransport,
  buildPeerKey,
  cleanupStaleRooms,
  closePeer,
  createRoomRecord,
  findPeerByConsumer,
  findPeerByTransport,
  getOrCreatePeer,
  removeConsumer,
  removeProducer,
  removeTransport,
  touchPeer,
  touchRoom,
  type PeerIdentity,
  type RoomRecord,
} from "./room-state.js";

type Router = mediasoup.types.Router;
type WebRtcTransport = mediasoup.types.WebRtcTransport;
type Producer = mediasoup.types.Producer;
type Consumer = mediasoup.types.Consumer;
type RouterRtpCodecCapability = mediasoup.types.RouterRtpCodecCapability;

type Room = RoomRecord<Router, WebRtcTransport, Producer, Consumer>;

const mediaCodecs: RouterRtpCodecCapability[] = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
    parameters: { "sprop-stereo": 1, usedtx: 1, useinbandfec: 1 },
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: { "x-google-start-bitrate": 1000 },
  },
  {
    kind: "video",
    mimeType: "video/VP9",
    clockRate: 90000,
    parameters: { "profile-id": 2, "x-google-start-bitrate": 1000 },
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
      "x-google-start-bitrate": 1000,
    },
  },
];

function isCapacitorOriginAllowed(origin: string): boolean {
  if (origin === "capacitor://localhost") {
    return true;
  }
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && url.hostname === "localhost";
  } catch {
    return false;
  }
}

export interface SfuServerConfig {
  port: number;
  trustProxy: string;
  announcedIp: string;
  jwtSecret: string;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  peerTtlMs: number;
  emptyRoomTtlMs: number;
  cleanupIntervalMs: number;
  topology: string;
  corsOrigin: string;
}

export interface SfuServerDeps {
  config: SfuServerConfig;
  workerPool: WorkerPool;
  rooms: Map<string, Room>;
  roomAccess: RoomAccessChecker;
}

export interface SfuServer {
  fastify: FastifyInstance;
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

export async function createSfuServer(deps: SfuServerDeps): Promise<SfuServer> {
  const { config, workerPool, rooms, roomAccess } = deps;
  const requestRateLimiter = new FixedWindowRateLimiter({
    maxRequests: Math.max(config.rateLimitMaxRequests, 1),
    windowMs: Math.max(config.rateLimitWindowMs, 1000),
  });

  function getPeerIdentity(auth: { sub: string; deviceId?: string; sessionId?: string }): PeerIdentity {
    return {
      userId: auth.sub,
      deviceId: auth.deviceId ?? null,
      sessionId: auth.sessionId ?? null,
    };
  }

  function getPeerKeyFromAuth(auth: { sub: string; deviceId?: string; sessionId?: string }): string {
    return buildPeerKey(getPeerIdentity(auth));
  }

  function buildRateLimitKey(request: FastifyRequest): string {
    const ip = request.ip || "unknown-ip";
    const reqAuth = request.auth;
    if (!reqAuth) {
      return `anon:${ip}`;
    }
    return `auth:${reqAuth.sub}:${reqAuth.deviceId ?? "legacy-device"}:${ip}`;
  }

  async function requireSfuRateLimit(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const decision = requestRateLimiter.check(buildRateLimitKey(request));
    void reply.header("X-RateLimit-Remaining", String(decision.remaining));
    if (!decision.allowed) {
      void reply.header(
        "Retry-After",
        String(Math.max(Math.ceil(decision.retryAfterMs / 1000), 1))
      );
      await reply.code(429).send({ error: "Too Many Requests" });
    }
  }

  async function getOrCreateRoom(roomId: string): Promise<Room> {
    const existing = rooms.get(roomId);
    if (existing) {
      touchRoom(existing);
      return existing;
    }
    const worker = workerPool.getNextWorker();
    const router = await worker.createRouter({ mediaCodecs });
    const room = createRoomRecord<Router, WebRtcTransport, Producer, Consumer>(
      roomId,
      router
    );
    rooms.set(roomId, room);
    return room;
  }

  const fastify = Fastify({
    logger: { level: "info" },
    trustProxy: config.trustProxy,
  });

  fastify.addHook("onRequest", async (_request, reply) => {
    const contentType = _request.headers["content-type"];
    if (typeof contentType === "string" && /[\t\r\n]/.test(contentType)) {
      return reply.code(400).send({ error: "Invalid Content-Type header" });
    }
  });

  const allowedOrigins = config.corsOrigin.split(",").map((o) => o.trim());
  await fastify.register(fastifyCors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (isCapacitorOriginAllowed(origin)) {
        return cb(null, true);
      }
      cb(null, allowedOrigins.includes(origin));
    },
    credentials: true,
  });
  await fastify.register(fastifyWebsocket);
  await fastify.register(fastifyJwt, {
    secret: config.jwtSecret,
    verify: { algorithms: ["HS256"] },
  });

  let cleanupTimer: NodeJS.Timeout | null = null;
  cleanupTimer = setInterval(() => {
    const result = cleanupStaleRooms(rooms, {
      peerTtlMs: Math.max(config.peerTtlMs, 1000),
      emptyRoomTtlMs: Math.max(config.emptyRoomTtlMs, 1000),
    });
    if (result.removedPeers > 0 || result.removedRooms > 0) {
      fastify.log.info(result, "SFU stale cleanup completed");
    }
  }, Math.max(config.cleanupIntervalMs, 1000));
  cleanupTimer.unref();

  fastify.get<{ Params: { roomId: string } }>(
    "/rooms/:roomId/rtp-capabilities",
    { preHandler: [requireSfuAuth, requireSfuRateLimit] },
    async (request, reply) => {
      if (!(await roomAccess.ensureRoomAccess(request, reply, request.params.roomId)))
        return;
      const room = await getOrCreateRoom(request.params.roomId);
      touchRoom(room);
      return SfuRtpCapabilitiesResponseSchema.parse({
        version: SFU_PROTOCOL_VERSION,
        rtpCapabilities: room.router.rtpCapabilities,
      });
    }
  );

  fastify.post(
    "/transports",
    { preHandler: [requireSfuAuth, requireSfuRateLimit] },
    async (request, reply) => {
      const body = parseVersionedOrReply(
        reply,
        SfuCreateTransportRequestSchema,
        request.body,
        SFU_PROTOCOL_VERSION
      );
      if (!body) return;
      if (body.userId !== request.auth.sub) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (!(await roomAccess.ensureRoomAccess(request, reply, body.roomId))) return;
      const room = await getOrCreateRoom(body.roomId);
      const peer = getOrCreatePeer(room, getPeerIdentity(request.auth), () =>
        nanoid()
      );

      const transport = await room.router.createWebRtcTransport({
        listenIps: [{ ip: "0.0.0.0", announcedIp: config.announcedIp }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 1_000_000,
      });

      attachTransport(room, peer, transport.id, transport);
      transport.on("dtlsstatechange", (state) => {
        if (state === "closed") {
          removeTransport(room, peer, transport.id);
        }
      });

      return SfuCreateTransportResponseSchema.parse({
        version: SFU_PROTOCOL_VERSION,
        transportId: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    }
  );

  fastify.post(
    "/transports/connect",
    { preHandler: [requireSfuAuth, requireSfuRateLimit] },
    async (request, reply) => {
      const body = parseVersionedOrReply(
        reply,
        SfuConnectTransportRequestSchema,
        request.body,
        SFU_PROTOCOL_VERSION
      );
      if (!body) return;
      if (!(await roomAccess.ensureRoomAccess(request, reply, body.roomId))) return;
      const room = rooms.get(body.roomId);
      if (!room) return reply.code(404).send({ error: "Room not found" });

      const owned = findPeerByTransport(room, body.transportId);
      if (!owned) return reply.code(404).send({ error: "Transport not found" });
      if (owned.peer.peerKey !== getPeerKeyFromAuth(request.auth)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      touchPeer(owned.peer);
      touchRoom(room);
      await owned.transport.connect({
        dtlsParameters: body.dtlsParameters as mediasoup.types.DtlsParameters,
      });
      return SfuConnectTransportResponseSchema.parse({
        version: SFU_PROTOCOL_VERSION,
        ok: true,
      });
    }
  );

  fastify.post(
    "/produce",
    { preHandler: [requireSfuAuth, requireSfuRateLimit] },
    async (request, reply) => {
      const body = parseVersionedOrReply(
        reply,
        SfuProduceRequestSchema,
        request.body,
        SFU_PROTOCOL_VERSION
      );
      if (!body) return;
      if (!(await roomAccess.ensureRoomAccess(request, reply, body.roomId))) return;
      const room = rooms.get(body.roomId);
      if (!room) return reply.code(404).send({ error: "Room not found" });

      const owned = findPeerByTransport(room, body.transportId);
      if (!owned) return reply.code(404).send({ error: "Transport not found" });
      if (owned.peer.peerKey !== getPeerKeyFromAuth(request.auth)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const producer = await owned.transport.produce({
        kind: body.kind,
        rtpParameters: normalizeSfuRtpParameters(
          body.rtpParameters as mediasoup.types.RtpParameters
        ) as mediasoup.types.RtpParameters,
      });
      const producerSource =
        body.kind === "video" ? body.source ?? "camera" : null;
      attachProducer(room, owned.peer, producer.id, producer, producerSource);
      producer.on("transportclose", () => {
        removeProducer(room, owned.peer, producer.id);
      });

      return SfuProduceResponseSchema.parse({
        version: SFU_PROTOCOL_VERSION,
        producerId: producer.id,
      });
    }
  );

  fastify.post<{ Params: { producerId: string } }>(
    "/producers/:producerId/close",
    { preHandler: [requireSfuAuth, requireSfuRateLimit] },
    async (request, reply) => {
      const { producerId } = request.params;
      const body = parseVersionedOrReply(
        reply,
        SfuCloseProducerRequestSchema,
        request.body,
        SFU_PROTOCOL_VERSION
      );
      if (!body) return;
      if (!(await roomAccess.ensureRoomAccess(request, reply, body.roomId))) return;

      const room = rooms.get(body.roomId);
      if (!room) {
        return SfuCloseProducerResponseSchema.parse({
          version: SFU_PROTOCOL_VERSION,
          ok: true,
        });
      }

      const ownerKey = room.producerOwners.get(producerId);
      if (!ownerKey) {
        return SfuCloseProducerResponseSchema.parse({
          version: SFU_PROTOCOL_VERSION,
          ok: true,
        });
      }
      if (ownerKey !== getPeerKeyFromAuth(request.auth)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const peer = room.peers.get(ownerKey);
      const producer = peer?.producers.get(producerId);
      if (!peer || !producer) {
        room.producerOwners.delete(producerId);
        room.producerSources.delete(producerId);
        return SfuCloseProducerResponseSchema.parse({
          version: SFU_PROTOCOL_VERSION,
          ok: true,
        });
      }

      touchPeer(peer);
      touchRoom(room);
      producer.close();
      removeProducer(room, peer, producerId);
      return SfuCloseProducerResponseSchema.parse({
        version: SFU_PROTOCOL_VERSION,
        ok: true,
      });
    }
  );

  fastify.post(
    "/consume",
    { preHandler: [requireSfuAuth, requireSfuRateLimit] },
    async (request, reply) => {
      const body = parseVersionedOrReply(
        reply,
        SfuConsumeRequestSchema,
        request.body,
        SFU_PROTOCOL_VERSION
      );
      if (!body) return;
      if (body.userId !== request.auth.sub) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (!(await roomAccess.ensureRoomAccess(request, reply, body.roomId))) return;

      const room = rooms.get(body.roomId);
      if (!room) return reply.code(404).send({ error: "Room not found" });

      const peerKey = getPeerKeyFromAuth(request.auth);
      const peer = room.peers.get(peerKey);
      if (!peer) return reply.code(404).send({ error: "Peer not found" });
      const owned = findPeerByTransport(room, body.transportId);
      if (!owned) return reply.code(404).send({ error: "Transport not found" });
      if (owned.peer.peerKey !== peerKey) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      if (
        !room.router.canConsume({
          producerId: body.producerId,
          rtpCapabilities:
            body.rtpCapabilities as mediasoup.types.RtpCapabilities,
        })
      ) {
        return reply.code(400).send({ error: "Cannot consume" });
      }

      const consumer = await owned.transport.consume({
        producerId: body.producerId,
        rtpCapabilities:
          body.rtpCapabilities as mediasoup.types.RtpCapabilities,
        paused: true,
      });
      attachConsumer(room, peer, consumer.id, consumer);
      consumer.on("transportclose", () => {
        removeConsumer(room, peer, consumer.id);
      });
      consumer.on("producerclose", () => {
        removeConsumer(room, peer, consumer.id);
      });

      return SfuConsumeResponseSchema.parse({
        version: SFU_PROTOCOL_VERSION,
        consumerId: consumer.id,
        producerId: body.producerId,
        kind: consumer.kind,
        rtpParameters: normalizeSfuRtpParameters(consumer.rtpParameters),
      });
    }
  );

  fastify.post<{
    Params: { consumerId: string };
    Body: { roomId: string; userId: string };
  }>(
    "/consumers/:consumerId/resume",
    { preHandler: [requireSfuAuth, requireSfuRateLimit] },
    async (request, reply) => {
      const { consumerId } = request.params;
      const body = parseVersionedOrReply(
        reply,
        SfuResumeConsumerRequestSchema,
        request.body,
        SFU_PROTOCOL_VERSION
      );
      if (!body) return;
      const { roomId, userId } = body;
      if (userId !== request.auth.sub) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (!(await roomAccess.ensureRoomAccess(request, reply, roomId))) return;
      const room = rooms.get(roomId);
      if (!room) return reply.code(404).send({ error: "Room not found" });
      const owned = findPeerByConsumer(room, consumerId);
      if (!owned) return reply.code(404).send({ error: "Consumer not found" });
      if (owned.peer.peerKey !== getPeerKeyFromAuth(request.auth)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      touchPeer(owned.peer);
      touchRoom(room);
      await owned.consumer.resume();
      return SfuResumeConsumerResponseSchema.parse({
        version: SFU_PROTOCOL_VERSION,
        ok: true,
      });
    }
  );

  fastify.get<{ Params: { roomId: string } }>(
    "/rooms/:roomId/producers",
    { preHandler: [requireSfuAuth, requireSfuRateLimit] },
    async (request, reply) => {
      if (!(await roomAccess.ensureRoomAccess(request, reply, request.params.roomId)))
        return;
      const room = rooms.get(request.params.roomId);
      if (!room) return reply.code(404).send({ error: "Room not found" });
      const peerKey = getPeerKeyFromAuth(request.auth);
      const currentPeer = room.peers.get(peerKey);
      if (!currentPeer) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      touchPeer(currentPeer);
      touchRoom(room);

      const producers: Array<{
        producerId: string;
        userId: string;
        deviceId?: string;
        sessionId?: string;
        kind: "audio" | "video";
        source?: "camera" | "screen";
      }> = [];
      for (const peer of room.peers.values()) {
        for (const [producerId, producer] of peer.producers) {
          const producerInfo: {
            producerId: string;
            userId: string;
            deviceId?: string;
            sessionId?: string;
            kind: "audio" | "video";
            source?: "camera" | "screen";
          } = {
            producerId,
            userId: peer.userId,
            kind: producer.kind,
          };
          if (peer.deviceId) {
            producerInfo.deviceId = peer.deviceId;
          }
          if (peer.sessionId) {
            producerInfo.sessionId = peer.sessionId;
          }
          const producerSource = room.producerSources.get(producerId);
          if (producerSource) {
            producerInfo.source = producerSource;
          }
          producers.push(producerInfo);
        }
      }
      return SfuRoomProducersResponseSchema.parse({
        version: SFU_PROTOCOL_VERSION,
        producers,
      });
    }
  );

  fastify.delete<{ Params: { roomId: string; userId: string } }>(
    "/rooms/:roomId/peers/:userId",
    { preHandler: [requireSfuAuth, requireSfuRateLimit] },
    async (request, reply) => {
      const { roomId, userId } = request.params;
      if (userId !== request.auth.sub) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const room = rooms.get(roomId);
      if (!room) return { ok: true };
      closePeer(room, getPeerKeyFromAuth(request.auth));

      if (room.peers.size === 0) {
        room.router.close();
        rooms.delete(roomId);
      }

      return SfuCloseProducerResponseSchema.parse({
        version: SFU_PROTOCOL_VERSION,
        ok: true,
      });
    }
  );

  /* ── Health endpoints ─────────────────────────────────────────────────── */

  fastify.get("/health/live", () => ({ status: "ok" }));

  fastify.get("/health/ready", async (_request, reply) => {
    const alive = workerPool.getAliveCount();
    if (alive === 0) {
      return reply.code(503).send({
        status: "degraded",
        reason: "no live mediasoup workers",
        topology: config.topology,
      });
    }
    return {
      status: "ok",
      topology: config.topology,
      workers: alive,
      rooms: rooms.size,
    };
  });

  fastify.get("/health", async (_request, reply) => {
    const alive = workerPool.getAliveCount();
    if (alive === 0) {
      return reply.code(503).send({ status: "degraded", workers: 0 });
    }
    return { status: "ok", workers: alive, rooms: rooms.size };
  });

  return {
    fastify,
    start: async () => {
      await fastify.listen({ port: config.port, host: "0.0.0.0" });
      console.log(
        `[sfu] Listening on port ${config.port} | topology=${config.topology} | workers=${workerPool.workers.length} | announcedIp=${config.announcedIp}`
      );
      if (config.announcedIp === "127.0.0.1" || config.announcedIp === "localhost") {
        console.warn(
          "[sfu] WARNING: ANNOUNCED_IP is set to localhost. Remote clients will not be able to establish WebRTC connections. Set ANNOUNCED_IP to the public/LAN IP in production."
        );
      }
    },
    shutdown: async () => {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      const forceExitTimer = setTimeout(() => {
        console.error("SFU graceful shutdown timed out — forcing exit");
        process.exit(1);
      }, 10_000).unref();

      await fastify.close();
      for (const w of workerPool.workers) w.close();
      clearTimeout(forceExitTimer);
    },
  };
}
