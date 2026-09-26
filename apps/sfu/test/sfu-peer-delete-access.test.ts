import { afterEach, describe, expect, it, vi } from "vitest";
import { createSfuServer, type SfuServerConfig } from "../src/sfu-server.js";

const baseConfig: SfuServerConfig = {
  port: 0,
  trustProxy: "loopback",
  announcedIp: "127.0.0.1",
  jwtSecret: "test-sfu-jwt-secret-0123456789abcd",
  rateLimitWindowMs: 10_000,
  rateLimitMaxRequests: 120,
  peerTtlMs: 120_000,
  emptyRoomTtlMs: 30_000,
  cleanupIntervalMs: 30_000,
  topology: "single-node",
  corsOrigin: "http://localhost:5173",
};

const openServers: Array<{ fastify: { close(): Promise<void> } }> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((s) => s.fastify.close()));
});

async function buildServer(
  ensureRoomAccess: () => Promise<boolean>
): Promise<Awaited<ReturnType<typeof createSfuServer>>> {
  const server = await createSfuServer({
    config: baseConfig,
    workerPool: {} as never,
    rooms: new Map(),
    roomAccess: {
      ensureRoomAccess: vi.fn(async (_request, reply) => {
        const allowed = await ensureRoomAccess();
        if (!allowed) {
          reply.code(403).send({ error: "Forbidden" });
        }
        return allowed;
      }),
    },
  });
  openServers.push(server);
  return server;
}

describe("DELETE /rooms/:roomId/peers/:userId room access", () => {
  it("enforces room access before mutating room state", async () => {
    const ensureRoomAccess = vi.fn(async () => false);
    const server = await buildServer(ensureRoomAccess);
    const token = server.fastify.jwt.sign({
      sub: "user-1",
      tokenUse: "access",
    });

    const response = await server.fastify.inject({
      method: "DELETE",
      url: "/rooms/room-1/peers/user-1",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(ensureRoomAccess).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(403);
  });

  it("allows the owner through when access is granted", async () => {
    const ensureRoomAccess = vi.fn(async () => true);
    const server = await buildServer(ensureRoomAccess);
    const token = server.fastify.jwt.sign({
      sub: "user-1",
      tokenUse: "access",
    });

    const response = await server.fastify.inject({
      method: "DELETE",
      url: "/rooms/room-1/peers/user-1",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(ensureRoomAccess).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
  });

  it("rejects deleting another user's peer without touching room access", async () => {
    const ensureRoomAccess = vi.fn(async () => true);
    const server = await buildServer(ensureRoomAccess);
    const token = server.fastify.jwt.sign({
      sub: "user-1",
      tokenUse: "access",
    });

    const response = await server.fastify.inject({
      method: "DELETE",
      url: "/rooms/room-1/peers/user-2",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(ensureRoomAccess).not.toHaveBeenCalled();
  });
});