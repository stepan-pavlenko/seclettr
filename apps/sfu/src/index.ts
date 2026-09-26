import type * as mediasoup from "mediasoup";
import os from "node:os";
import { config } from "./config.js";
import { createWorkerPool } from "./sfu-worker-pool.js";
import { createRoomAccessChecker } from "./sfu-room-access.js";
import { createSfuServer, type SfuServerConfig } from "./sfu-server.js";
import type { RoomRecord } from "./room-state.js";

type Worker = mediasoup.types.Worker;
type Router = mediasoup.types.Router;
type WebRtcTransport = mediasoup.types.WebRtcTransport;
type Producer = mediasoup.types.Producer;
type Consumer = mediasoup.types.Consumer;

type Room = RoomRecord<Router, WebRtcTransport, Producer, Consumer>;

async function main(): Promise<void> {
  const rooms = new Map<string, Room>();

  const workerPool = createWorkerPool(
    {
      rtcMinPort: config.MIN_PORT,
      rtcMaxPort: config.MAX_PORT,
    },
    (_deadWorker: Worker) => {
      // Evict rooms whose router is now closed (owned by the dead worker).
      for (const [roomId, room] of rooms) {
        if (room.router.closed) {
          rooms.delete(roomId);
          console.warn(`[sfu] evicted room ${roomId} after worker death`);
        }
      }
    }
  );

  const numWorkers = Math.min(os.cpus().length, 4);
  await workerPool.spawnAll(numWorkers);
  console.log(`Spawned ${numWorkers} mediasoup workers`);

  const roomAccess = createRoomAccessChecker({
    apiInternalUrl: config.API_INTERNAL_URL,
    roomAccessTimeoutMs: config.ROOM_ACCESS_TIMEOUT_MS,
  });

  const serverConfig: SfuServerConfig = {
    port: config.PORT,
    trustProxy: config.TRUST_PROXY,
    announcedIp: config.ANNOUNCED_IP,
    jwtSecret: config.JWT_SECRET,
    rateLimitWindowMs: config.RATE_LIMIT_WINDOW_MS,
    rateLimitMaxRequests: config.RATE_LIMIT_MAX_REQUESTS,
    peerTtlMs: config.PEER_TTL_MS,
    emptyRoomTtlMs: config.EMPTY_ROOM_TTL_MS,
    cleanupIntervalMs: config.CLEANUP_INTERVAL_MS,
    topology: config.TOPOLOGY,
    corsOrigin: process.env["CORS_ORIGIN"] ?? "http://localhost:5173",
    maxRooms: config.MAX_ROOMS,
    maxPeersPerRoom: config.MAX_PEERS_PER_ROOM,
    maxTransportsPerPeer: config.MAX_TRANSPORTS_PER_PEER,
    maxProducersPerPeer: config.MAX_PRODUCERS_PER_PEER,
    maxConsumersPerPeer: config.MAX_CONSUMERS_PER_PEER,
    rateLimitMaxBuckets: config.RATE_LIMIT_MAX_BUCKETS,
  };

  const server = await createSfuServer({
    config: serverConfig,
    workerPool,
    rooms,
    roomAccess,
  });

  process.on("SIGTERM", () => {
    void server.shutdown();
  });

  await server.start();
}

try {
  await main();
} catch (err) {
  console.error("SFU startup failed:", err);
  process.exit(1);
}
