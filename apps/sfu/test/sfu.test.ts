import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "../src/http-rate-limit.js";
import {
  attachTransport,
  buildPeerKey,
  cleanupStaleRooms,
  createRoomRecord,
  findPeerByTransport,
  getOrCreatePeer,
} from "../src/room-state.js";
import type { Closable } from "../src/room-state.js";

interface MockClosable extends Closable {
  closed: boolean;
}

function createClosable(): MockClosable {
  return { closed: false, close() { this.closed = true; } };
}

describe("SFU rate limiter", () => {
  it("enforces a fixed request window and resets after expiry", () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({
      maxRequests: 2,
      windowMs: 1000,
      now: () => now,
    });

    expect(limiter.check("peer-1")).toMatchObject({
      allowed: true,
      remaining: 1,
      retryAfterMs: 0,
    });
    expect(limiter.check("peer-1")).toMatchObject({
      allowed: true,
      remaining: 0,
      retryAfterMs: 0,
    });

    const blocked = limiter.check("peer-1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBe(1000);

    now = 1001;
    expect(limiter.check("peer-1")).toMatchObject({
      allowed: true,
      remaining: 1,
      retryAfterMs: 0,
    });
  });

  it("caps retained buckets and fails closed instead of growing unbounded", () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      maxBuckets: 3,
      now: () => now,
    });

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("c").allowed).toBe(true);

    // At the cap with no expired buckets, a new key must be rejected.
    expect(limiter.check("d").allowed).toBe(false);

    // Once buckets expire, the sweep frees capacity for new keys again.
    now = 1001;
    expect(limiter.check("e").allowed).toBe(true);
  });
});

describe("SFU room state", () => {
  it("keys peers by user + device + session so multiple devices coexist", () => {
    const room = createRoomRecord<MockClosable, MockClosable, MockClosable, MockClosable>(
      "room-1", createClosable(), 0
    );

    const peerA = getOrCreatePeer(
      room,
      { userId: "user-1", deviceId: "device-a", sessionId: "session-a" },
      () => "peer-a",
      1
    );
    const peerB = getOrCreatePeer(
      room,
      { userId: "user-1", deviceId: "device-b", sessionId: "session-b" },
      () => "peer-b",
      2
    );

    expect(peerA.peerKey).toBe(buildPeerKey({
      userId: "user-1",
      deviceId: "device-a",
      sessionId: "session-a",
    }));
    expect(peerB.peerKey).toBe(buildPeerKey({
      userId: "user-1",
      deviceId: "device-b",
      sessionId: "session-b",
    }));
    expect(peerA.peerKey).not.toBe(peerB.peerKey);
    expect(room.peers.size).toBe(2);
  });

  it("tracks transport ownership without scanning all peers", () => {
    const room = createRoomRecord<MockClosable, MockClosable, MockClosable, MockClosable>(
      "room-2", createClosable(), 0
    );
    const peer = getOrCreatePeer(
      room,
      { userId: "user-1", deviceId: "device-a", sessionId: "session-a" },
      () => "peer-a",
      1
    );
    const transport = createClosable();

    attachTransport(room, peer, "transport-1", transport, 2);
    const owned = findPeerByTransport(room, "transport-1");

    expect(owned).not.toBeNull();
    expect(owned?.peer.peerKey).toBe(peer.peerKey);
    expect(owned?.transport).toBe(transport);
  });

  it("evicts stale peers first and then removes empty rooms after TTL", () => {
    const room = createRoomRecord<MockClosable, MockClosable, MockClosable, MockClosable>(
      "room-3", createClosable(), 0
    );
    const rooms = new Map<string, typeof room>();
    rooms.set(room.roomId, room);

    const peer = getOrCreatePeer(
      room,
      { userId: "user-1", deviceId: "device-a", sessionId: "session-a" },
      () => "peer-a",
      0
    );
    attachTransport(room, peer, "transport-1", createClosable(), 0);

    const firstPass = cleanupStaleRooms(rooms, {
      peerTtlMs: 100,
      emptyRoomTtlMs: 50,
      now: 150,
    });
    expect(firstPass).toEqual({ removedPeers: 1, removedRooms: 0 });
    expect(rooms.has("room-3")).toBe(true);

    const secondPass = cleanupStaleRooms(rooms, {
      peerTtlMs: 100,
      emptyRoomTtlMs: 50,
      now: 210,
    });
    expect(secondPass).toEqual({ removedPeers: 0, removedRooms: 1 });
    expect(rooms.has("room-3")).toBe(false);
    expect(room.router.closed).toBe(true);
  });
});
