/**
 * Unit tests for the WebSocket token extraction and validation helpers.
 *
 * These tests are pure (no DB, no network, no Fastify server).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";

// WS_AUTH_PROTOCOL_PREFIX = "seclettr.auth."
const WS_PREFIX = "seclettr.auth.";
const LEGACY_PREFIX = "qm.auth.";

// ws-auth.ts imports config.ts which requires DATABASE_URL + JWT_SECRET at module load.
function applyMinimalEnv() {
  process.env["DATABASE_URL"] = "postgresql://seclettr:pass@localhost:5432/seclettr";
  process.env["JWT_SECRET"] = "12345678901234567890123456789012";
}

// Isolated import so NODE_ENV can be controlled per suite.
async function loadWsAuth() {
  vi.resetModules();
  applyMinimalEnv();
  const mod = await import("../services/ws-auth.js");
  return mod;
}

beforeEach(() => {
  applyMinimalEnv();
});

function fakeRequest(headers: Record<string, string | string[] | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

function fakeFastify(verifyResult: object): FastifyInstance {
  return {
    jwt: { verify: vi.fn().mockReturnValue(verifyResult) },
  } as unknown as FastifyInstance;
}

// ── extractWebSocketToken ──────────────────────────────────────────────────

describe("extractWebSocketToken — Authorization header", () => {
  it("extracts token from Bearer Authorization header", async () => {
    const { extractWebSocketToken } = await loadWsAuth();
    const req = fakeRequest({ authorization: "Bearer my.jwt.token" });
    const result = extractWebSocketToken(req);
    expect(result).toEqual({ token: "my.jwt.token", source: "authorization" });
  });

  it("is case-insensitive on 'bearer' prefix", async () => {
    const { extractWebSocketToken } = await loadWsAuth();
    const req = fakeRequest({ authorization: "BEARER abc.def.ghi" });
    const result = extractWebSocketToken(req);
    expect(result).toEqual({ token: "abc.def.ghi", source: "authorization" });
  });

  it("trims whitespace from extracted token", async () => {
    const { extractWebSocketToken } = await loadWsAuth();
    const req = fakeRequest({ authorization: "Bearer   trimmed.token  " });
    const result = extractWebSocketToken(req);
    expect(result?.token).toBe("trimmed.token");
  });

  it("ignores non-Bearer Authorization values", async () => {
    const { extractWebSocketToken } = await loadWsAuth();
    const req = fakeRequest({ authorization: "Basic dXNlcjpwYXNz" });
    const result = extractWebSocketToken(req);
    expect(result).toBeNull();
  });
});

describe("extractWebSocketToken — Sec-WebSocket-Protocol header", () => {
  it("extracts token with seclettr.auth. prefix", async () => {
    const { extractWebSocketToken } = await loadWsAuth();
    const req = fakeRequest({ "sec-websocket-protocol": `${WS_PREFIX}tok.en.here` });
    const result = extractWebSocketToken(req);
    expect(result).toEqual({ token: "tok.en.here", source: "protocol" });
  });

  it("extracts token when protocol list has other protocols too", async () => {
    const { extractWebSocketToken } = await loadWsAuth();
    const req = fakeRequest({
      "sec-websocket-protocol": `chat, ${WS_PREFIX}tok.en.here, other`,
    });
    const result = extractWebSocketToken(req);
    expect(result).toEqual({ token: "tok.en.here", source: "protocol" });
  });

  it("handles array-form header", async () => {
    const { extractWebSocketToken } = await loadWsAuth();
    const req = fakeRequest({
      "sec-websocket-protocol": [`chat`, `${WS_PREFIX}arr.token`],
    });
    const result = extractWebSocketToken(req);
    expect(result).toEqual({ token: "arr.token", source: "protocol" });
  });

  it("extracts legacy qm.auth. prefix token in test env", async () => {
    const { extractWebSocketToken } = await loadWsAuth();
    const req = fakeRequest({ "sec-websocket-protocol": `${LEGACY_PREFIX}leg.acy.tok` });
    // extractWebSocketToken always extracts regardless of env — enforcement is in verify
    const result = extractWebSocketToken(req);
    expect(result).toEqual({ token: "leg.acy.tok", source: "protocol" });
  });

  it("returns null when no matching protocol and no auth header", async () => {
    const { extractWebSocketToken } = await loadWsAuth();
    const req = fakeRequest({ "sec-websocket-protocol": "chat, other-protocol" });
    const result = extractWebSocketToken(req);
    expect(result).toBeNull();
  });

  it("returns null when no headers at all", async () => {
    const { extractWebSocketToken } = await loadWsAuth();
    const req = fakeRequest({});
    const result = extractWebSocketToken(req);
    expect(result).toBeNull();
  });
});

describe("extractWebSocketToken — header precedence", () => {
  it("prefers Authorization header over Sec-WebSocket-Protocol", async () => {
    const { extractWebSocketToken } = await loadWsAuth();
    const req = fakeRequest({
      authorization: "Bearer auth.header.token",
      "sec-websocket-protocol": `${WS_PREFIX}proto.token`,
    });
    const result = extractWebSocketToken(req);
    expect(result?.token).toBe("auth.header.token");
    expect(result?.source).toBe("authorization");
  });
});

// ── verifyWebSocketToken ───────────────────────────────────────────────────

describe("verifyWebSocketToken — valid cases", () => {
  it("accepts a ws-scoped token from protocol header", async () => {
    const { verifyWebSocketToken } = await loadWsAuth();
    const payload = { sub: "u1", deviceId: "d1", tokenUse: "ws" };
    const fastify = fakeFastify(payload);
    const req = fakeRequest({ "sec-websocket-protocol": `${WS_PREFIX}ws.token` });
    const result = verifyWebSocketToken(fastify, req);
    expect(result).toEqual(payload);
  });

  it("accepts any token from Authorization header regardless of tokenUse", async () => {
    const { verifyWebSocketToken } = await loadWsAuth();
    const payload = { sub: "u1", deviceId: "d1", tokenUse: "access" };
    const fastify = fakeFastify(payload);
    const req = fakeRequest({ authorization: "Bearer access.token" });
    const result = verifyWebSocketToken(fastify, req);
    expect(result).toEqual(payload);
  });

  it("accepts ws-scoped token from Authorization header", async () => {
    const { verifyWebSocketToken } = await loadWsAuth();
    const payload = { sub: "u1", deviceId: "d1", tokenUse: "ws" };
    const fastify = fakeFastify(payload);
    const req = fakeRequest({ authorization: "Bearer ws.token" });
    const result = verifyWebSocketToken(fastify, req);
    expect(result).toEqual(payload);
  });
});

describe("verifyWebSocketToken — rejection cases", () => {
  it("throws when no token is present", async () => {
    const { verifyWebSocketToken } = await loadWsAuth();
    const fastify = fakeFastify({});
    const req = fakeRequest({});
    expect(() => verifyWebSocketToken(fastify, req)).toThrow("No token");
  });

  it("throws when JWT verification fails", async () => {
    vi.resetModules();
    const { verifyWebSocketToken } = await loadWsAuth();
    const fastify = {
      jwt: { verify: vi.fn().mockImplementation(() => { throw new Error("invalid signature"); }) },
    } as unknown as FastifyInstance;
    const req = fakeRequest({ authorization: "Bearer bad.token" });
    expect(() => verifyWebSocketToken(fastify, req)).toThrow("invalid signature");
  });

  it("throws when access token is sent via protocol header in non-dev env", async () => {
    // NODE_ENV is "test" in CI, so ALLOW_LEGACY_PROTOCOL_ACCESS_TOKENS = false
    vi.resetModules();
    process.env["NODE_ENV"] = "test";
    const { verifyWebSocketToken } = await loadWsAuth();
    const payload = { sub: "u1", deviceId: "d1", tokenUse: "access" };
    const fastify = fakeFastify(payload);
    const req = fakeRequest({ "sec-websocket-protocol": `${WS_PREFIX}access.token` });
    expect(() => verifyWebSocketToken(fastify, req)).toThrow("WS protocol token must be ws-scoped");
  });

  it("throws when token has no tokenUse and is sent via protocol header in non-dev env", async () => {
    vi.resetModules();
    process.env["NODE_ENV"] = "test";
    const { verifyWebSocketToken } = await loadWsAuth();
    const payload = { sub: "u1", deviceId: "d1" }; // no tokenUse
    const fastify = fakeFastify(payload);
    const req = fakeRequest({ "sec-websocket-protocol": `${WS_PREFIX}legacy.token` });
    expect(() => verifyWebSocketToken(fastify, req)).toThrow(
      "WS token must be ws- or access-scoped"
    );
  });

  it("throws when a guest token is sent via Authorization header", async () => {
    vi.resetModules();
    process.env["NODE_ENV"] = "test";
    const { verifyWebSocketToken } = await loadWsAuth();
    const payload = { sub: "g1", deviceId: "g1", tokenUse: "guest" };
    const fastify = fakeFastify(payload);
    const req = fakeRequest({ authorization: "Bearer guest.token" });
    expect(() => verifyWebSocketToken(fastify, req)).toThrow(
      "WS token must be ws- or access-scoped"
    );
  });

  it("throws when a contact token is sent via Authorization header", async () => {
    vi.resetModules();
    process.env["NODE_ENV"] = "test";
    const { verifyWebSocketToken } = await loadWsAuth();
    const payload = { sub: "u1", deviceId: "d1", tokenUse: "contact" };
    const fastify = fakeFastify(payload);
    const req = fakeRequest({ authorization: "Bearer contact.token" });
    expect(() => verifyWebSocketToken(fastify, req)).toThrow(
      "WS token must be ws- or access-scoped"
    );
  });
});
