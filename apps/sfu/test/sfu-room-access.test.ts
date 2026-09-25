import { describe, expect, it, vi } from "vitest";
import {
  createRoomAccessChecker,
  requireSfuAuth,
} from "../src/sfu-room-access.js";

function createReply() {
  return {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
}

describe("requireSfuAuth", () => {
  it("accepts access tokens", async () => {
    const reply = createReply();
    const request = {
      jwtVerify: vi.fn(),
      user: { sub: "user-1", tokenUse: "access" },
    };

    await requireSfuAuth(request as never, reply as never);

    expect(request.auth).toEqual({ sub: "user-1", tokenUse: "access" });
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("accepts guest tokens", async () => {
    const reply = createReply();
    const request = {
      jwtVerify: vi.fn(),
      user: { sub: "guest-1", tokenUse: "guest" },
    };

    await requireSfuAuth(request as never, reply as never);

    expect(request.auth).toEqual({ sub: "guest-1", tokenUse: "guest" });
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("rejects tokens with an unexpected tokenUse", async () => {
    const reply = createReply();
    const request = {
      jwtVerify: vi.fn(),
      user: { sub: "user-1", tokenUse: "refresh" },
    };

    await requireSfuAuth(request as never, reply as never);

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: "Unauthorized" });
  });

  it("rejects when jwt verification fails", async () => {
    const reply = createReply();
    const request = {
      jwtVerify: vi.fn().mockRejectedValue(new Error("bad token")),
      user: undefined,
    };

    await requireSfuAuth(request as never, reply as never);

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: "Unauthorized" });
  });
});

describe("createRoomAccessChecker", () => {
  it("returns expected interface", () => {
    const checker = createRoomAccessChecker({
      apiInternalUrl: "http://localhost:3001",
      roomAccessTimeoutMs: 3000,
    });

    expect(checker).toBeDefined();
    expect(typeof checker.ensureRoomAccess).toBe("function");
  });

  it("rejects immediately when no authorization header", async () => {
    const checker = createRoomAccessChecker({
      apiInternalUrl: "http://localhost:3001",
      roomAccessTimeoutMs: 3000,
    });

    const reply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    const result = await checker.ensureRoomAccess(
      { headers: {}, ip: "127.0.0.1" } as never,
      reply as never,
      "room-1"
    );

    expect(result).toBe(false);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: "Unauthorized" });
  });

  it("rejects when authorization header is empty string", async () => {
    const checker = createRoomAccessChecker({
      apiInternalUrl: "http://localhost:3001",
      roomAccessTimeoutMs: 3000,
    });

    const reply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    const result = await checker.ensureRoomAccess(
      { headers: { authorization: "  " }, ip: "127.0.0.1" } as never,
      reply as never,
      "room-1"
    );

    expect(result).toBe(false);
    expect(reply.code).toHaveBeenCalledWith(401);
  });
});
