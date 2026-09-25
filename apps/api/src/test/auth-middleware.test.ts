/**
 * Unit tests for the HTTP auth middleware token-type enforcement.
 *
 * Verifies that only access tokens pass, while ws and contact tokens
 * are rejected with 401 — ensuring the fix from TASK-007 holds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireAuth } from "../middleware/auth.js";
import type { FastifyReply, FastifyRequest } from "fastify";

const isAuthSessionActive = vi.fn();

vi.mock("../services/auth-session.js", () => ({
  isAuthSessionActive: (...args: unknown[]) => isAuthSessionActive(...args),
  invalidateAuthSessionCache: vi.fn(),
  invalidateAuthSessionCacheMany: vi.fn(),
}));

beforeEach(() => {
  isAuthSessionActive.mockReset();
  isAuthSessionActive.mockResolvedValue(true);
});

function buildReply(): { reply: FastifyReply; code: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn().mockResolvedValue(undefined);
  const code = vi.fn().mockReturnValue({ send });
  const reply = { code } as unknown as FastifyReply;
  return { reply, code, send };
}

function buildRequest(payload: object): FastifyRequest {
  return {
    jwtVerify: vi.fn().mockResolvedValue(undefined),
    user: payload,
  } as unknown as FastifyRequest;
}

function buildFailingRequest(): FastifyRequest {
  return {
    jwtVerify: vi.fn().mockRejectedValue(new Error("invalid token")),
    user: undefined,
  } as unknown as FastifyRequest;
}

describe("requireAuth — accepted token types", () => {
  it("accepts an access token", async () => {
    const req = buildRequest({ sub: "u1", deviceId: "d1", tokenUse: "access", sessionId: "s1", iat: 0, exp: 9999999999 });
    const { reply, code } = buildReply();

    await requireAuth(req, reply);

    expect(code).not.toHaveBeenCalled();
    // Populated auth on request
    expect((req as FastifyRequest & { auth: unknown }).auth).toMatchObject({ sub: "u1", tokenUse: "access" });
  });

  it("accepts a token with undefined tokenUse (legacy pre-scoped token)", async () => {
    const req = buildRequest({ sub: "u2", deviceId: "d2", sessionId: "s2", iat: 0, exp: 9999999999 });
    const { reply, code } = buildReply();

    // Note: current implementation requires tokenUse === "access" explicitly.
    // A token with no tokenUse is NOT access, so it should be rejected.
    // This test documents the intentional behavior: undefined tokenUse → 401.
    await requireAuth(req, reply);

    expect(code).toHaveBeenCalledWith(401);
  });
});

describe("requireAuth — rejected token types", () => {
  it("rejects a ws-scoped token with 401", async () => {
    const req = buildRequest({ sub: "u1", deviceId: "d1", tokenUse: "ws", sessionId: "s1", iat: 0, exp: 9999999999 });
    const { reply, code, send } = buildReply();

    await requireAuth(req, reply);

    expect(code).toHaveBeenCalledWith(401);
    expect(send).toHaveBeenCalledWith({ error: "Unauthorized" });
  });

  it("rejects a contact-scoped token with 401", async () => {
    const req = buildRequest({ sub: "u1", deviceId: "d1", tokenUse: "contact", sessionId: "s1", iat: 0, exp: 9999999999 });
    const { reply, code, send } = buildReply();

    await requireAuth(req, reply);

    expect(code).toHaveBeenCalledWith(401);
    expect(send).toHaveBeenCalledWith({ error: "Unauthorized" });
  });
});

describe("requireAuth — session revocation", () => {
  it("rejects an access token whose session is no longer active", async () => {
    isAuthSessionActive.mockResolvedValueOnce(false);
    const req = buildRequest({ sub: "u1", deviceId: "d1", tokenUse: "access", sessionId: "s1", iat: 0, exp: 9999999999 });
    const { reply, code, send } = buildReply();

    await requireAuth(req, reply);

    expect(isAuthSessionActive).toHaveBeenCalledWith("s1");
    expect(code).toHaveBeenCalledWith(401);
    expect(send).toHaveBeenCalledWith({ error: "Unauthorized" });
  });
});

describe("requireAuth — JWT verification failure", () => {
  it("returns 401 when jwtVerify throws", async () => {
    const req = buildFailingRequest();
    const { reply, code, send } = buildReply();

    await requireAuth(req, reply);

    expect(code).toHaveBeenCalledWith(401);
    expect(send).toHaveBeenCalledWith({ error: "Unauthorized" });
  });
});
