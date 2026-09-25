import { describe, it, expect, beforeAll } from "vitest";
import WebSocket from "ws";
import { ensureSodium, toBase64Url } from "@seclettr/crypto";
import {
  AUTH_PROTOCOL_VERSION,
  GROUPS_PROTOCOL_VERSION,
  MESSAGE_PROTOCOL_VERSION,
  WS_PROTOCOL_VERSION,
  GroupActiveCallSchema,
  GroupCallParticipantDevicesResponseSchema,
  GroupCallParticipantsResponseSchema,
  GroupHistoryResponseSchema,
  GroupMemberDevicesResponseSchema,
  type WsServerMessage,
  WsServerMessageSchema,
} from "@seclettr/protocol";
import {
  buildAnswerCallAuthMaterial,
  buildOfferCallAuthMaterial,
  hashCallSdp,
} from "../services/call-auth.js";
import { query } from "../db/pool.js";

const BASE_URL = process.env["API_URL"] ?? "http://localhost:3001";
const TURN_DOMAIN = process.env["TURN_DOMAIN"] ?? "localhost";
const TURN_PORT = process.env["TURN_PORT"] ?? "3478";
const TURNS_PORT = process.env["TURNS_PORT"] ?? "5349";
type ServerMessage = WsServerMessage;
const wsMessageQueues = new WeakMap<WebSocket, ServerMessage[]>();

function withProtocolVersionIfMissing(
  path: string,
  method: string,
  body: RequestInit["body"]
): RequestInit["body"] {
  if (typeof body !== "string") {
    return body;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return body;
  }
  if ("version" in parsed) {
    return body;
  }

  const normalizedPath = path.split("?")[0] ?? path;
  const normalizedMethod = method.toUpperCase();
  let version: number | null = null;

  if (
    normalizedMethod === "POST" &&
    (normalizedPath === "/auth/register" || normalizedPath === "/auth/login")
  ) {
    version = AUTH_PROTOCOL_VERSION;
  } else if (
    normalizedMethod === "POST" &&
    (normalizedPath === "/messages" ||
      /^\/groups\/[^/]+\/messages$/.test(normalizedPath))
  ) {
    version = MESSAGE_PROTOCOL_VERSION;
  } else if (
    (normalizedMethod === "POST" || normalizedMethod === "PUT") &&
    (normalizedPath === "/groups" ||
      /^\/groups\/[^/]+\/members$/.test(normalizedPath) ||
      /^\/groups\/[^/]+\/members\/[^/]+\/role$/.test(normalizedPath))
  ) {
    version = GROUPS_PROTOCOL_VERSION;
  }

  if (!version) {
    return body;
  }

  return JSON.stringify({
    version,
    ...parsed,
  });
}

function expectedTurnUris(): string[] {
  return [
    `stun:${TURN_DOMAIN}:${TURN_PORT}`,
    `turn:${TURN_DOMAIN}:${TURN_PORT}?transport=udp`,
    `turn:${TURN_DOMAIN}:${TURN_PORT}?transport=tcp`,
    `turns:${TURN_DOMAIN}:${TURNS_PORT}?transport=tcp`,
  ];
}

async function apiRequest(
  path: string,
  options: RequestInit = {},
  token?: string
): Promise<{ status: number; body: unknown }> {
  const method = options.method ?? "GET";
  const body = withProtocolVersionIfMissing(path, method, options.body);
  const headers = new Headers(options.headers);
  if (
    !headers.has("Content-Type") &&
    body !== undefined &&
    body !== null
  ) {
    headers.set("Content-Type", "application/json");
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    method,
    ...(body !== undefined ? { body } : {}),
    headers,
  });

  const responseBody = await res.json().catch(() => ({}));
  return { status: res.status, body: responseBody };
}

async function createDirectCallId(
  callerToken: string,
  calleeUserId: string,
  callType: "audio" | "video"
): Promise<string> {
  const created = await apiRequest(
    "/calls",
    {
      method: "POST",
      body: JSON.stringify({
        calleeUserId,
        callType,
      }),
    },
    callerToken
  );
  expect(created.status).toBe(200);
  return (created.body as { callId: string }).callId;
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 100
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

async function loadPersistedCallSession(callId: string): Promise<{
  status: "ringing" | "active" | "ended" | "missed" | "rejected";
  answered_at: string | null;
  ended_at: string | null;
} | null> {
  const rows = await query<{
    status: "ringing" | "active" | "ended" | "missed" | "rejected";
    answered_at: string | null;
    ended_at: string | null;
  }>(
    `SELECT status, answered_at::text, ended_at::text
     FROM call_sessions
     WHERE id = $1`,
    [callId]
  );
  return rows[0] ?? null;
}

async function issueWsTicket(accessToken: string): Promise<string> {
  const ticketResponse = await apiRequest(
    "/auth/ws-ticket",
    { method: "POST" },
    accessToken
  );
  expect(ticketResponse.status).toBe(200);
  const wsToken = (ticketResponse.body as { wsToken?: string }).wsToken;
  expect(typeof wsToken).toBe("string");
  return wsToken!;
}

async function openAuthedWebSocket(token: string): Promise<WebSocket> {
  const wsUrl = `${BASE_URL.replace(/^http/, "ws")}/ws`;
  const wsToken = await issueWsTicket(token);
  const ws = new WebSocket(wsUrl, ["seclettr.v1", `seclettr.auth.${wsToken}`]);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("WS open timeout")),
      3000
    );
    ws.once("open", () => {
      clearTimeout(timeout);
      const queue: ServerMessage[] = [];
      wsMessageQueues.set(ws, queue);
      ws.on("message", (rawData) => {
        try {
          const parsed = WsServerMessageSchema.safeParse(
            JSON.parse(rawData.toString())
          );
          if (parsed.success) {
            queue.push(parsed.data as WsServerMessage);
            if (queue.length > 128) {
              queue.shift();
            }
          }
        } catch {}
      });
      ws.once("close", () => {
        wsMessageQueues.delete(ws);
      });

      const baseSend = ws.send.bind(ws);
      (ws as unknown as { send: (...args: unknown[]) => unknown }).send = (
        data: unknown,
        ...args: unknown[]
      ) => {
        let payload = data;
        if (typeof payload === "string") {
          try {
            const parsed = JSON.parse(payload);
            if (
              parsed &&
              typeof parsed === "object" &&
              !Array.isArray(parsed) &&
              !("version" in parsed)
            ) {
              payload = JSON.stringify({
                version: WS_PROTOCOL_VERSION,
                ...(parsed as Record<string, unknown>),
              });
            }
          } catch {
            // Non-JSON payloads are forwarded as-is.
          }
        }

        return (baseSend as (...inner: unknown[]) => unknown)(payload, ...args);
      };
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  return ws;
}

function takeQueuedWsMessage(
  ws: WebSocket,
  predicate: (msg: ServerMessage) => boolean
): ServerMessage | null {
  const queue = wsMessageQueues.get(ws);
  if (!queue) return null;

  const matchIndex = queue.findIndex(predicate);
  if (matchIndex === -1) return null;

  return queue.splice(matchIndex, 1)[0] ?? null;
}

async function waitForWsMessage(
  ws: WebSocket,
  predicate: (msg: ServerMessage) => boolean,
  timeoutMs = 3000
): Promise<ServerMessage> {
  const immediateMatch = takeQueuedWsMessage(ws, predicate);
  if (immediateMatch) {
    return immediateMatch;
  }

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const interval = setInterval(() => {
      const message = takeQueuedWsMessage(ws, predicate);
      if (message) {
        clearInterval(interval);
        resolve(message);
        return;
      }

      if (Date.now() >= deadline) {
        clearInterval(interval);
        reject(new Error("WS message timeout"));
      }
    }, 25);
  });
}

async function registerUser(
  username: string,
  deviceOverrides: Partial<{
    name: string;
    identityKeyPublic: string;
    signingKeyPublic: string;
    registrationId: number;
    signedPreKey: {
      id: number;
      publicKey: string;
      signature: string;
    };
    oneTimePreKeys: Array<{ id: number; publicKey: string }>;
  }> = {}
) {
  const fakeKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const fakeSig =
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const device = {
    name: deviceOverrides.name ?? "Test Device",
    identityKeyPublic: deviceOverrides.identityKeyPublic ?? fakeKey,
    signingKeyPublic: deviceOverrides.signingKeyPublic ?? fakeKey,
    registrationId:
      deviceOverrides.registrationId ?? Math.floor(Math.random() * 16382) + 1,
    signedPreKey: deviceOverrides.signedPreKey ?? {
      id: 1,
      publicKey: fakeKey,
      signature: fakeSig,
    },
    oneTimePreKeys:
      deviceOverrides.oneTimePreKeys ??
      Array.from({ length: 5 }, (_, i) => ({
        id: i + 1,
        publicKey: fakeKey,
      })),
  };

  return apiRequest("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      version: AUTH_PROTOCOL_VERSION,
      username,
      password: "TestPassword123!",
      device,
    }),
  });
}

async function createDirectRelationship(token: string, targetUserId: string) {
  return apiRequest(
    `/users/${targetUserId}/direct-relationship`,
    { method: "POST" },
    token
  );
}

describe("Health check", () => {
  it("returns ok status", async () => {
    const { status, body } = await apiRequest("/health");
    expect(status).toBe(200);
    expect((body as { status: string }).status).toMatch(/ok|degraded/);
  });
});

describe("Auth: Registration", () => {
  const username = `testuser_${Date.now()}`;

  it("registers a new user successfully", async () => {
    const { status, body } = await registerUser(username);
    expect(status).toBe(201);
    const typed = body as {
      userId?: string;
      deviceId?: string;
      accessToken?: string;
    };
    expect(typed.userId).toBeDefined();
    expect(typed.deviceId).toBeDefined();
    expect(typed.accessToken).toBeDefined();
    expect(typeof typed.accessToken).toBe("string");
  });

  it("rejects duplicate username", async () => {
    await registerUser(username);
    const { status, body } = await registerUser(username);
    expect([409, 201]).toContain(status);
  });

  it("rejects short password", async () => {
    const { status } = await apiRequest("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        version: AUTH_PROTOCOL_VERSION,
        username: `shortpw_${Date.now()}`,
        password: "short",
        device: {
          name: "Test",
          identityKeyPublic: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          signingKeyPublic: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          registrationId: 1,
          signedPreKey: { id: 1, publicKey: "AAA", signature: "AAA" },
          oneTimePreKeys: [{ id: 1, publicKey: "AAA" }],
        },
      }),
    });
    expect(status).toBe(400);
  });

  it("rejects invalid username characters", async () => {
    const { status } = await registerUser("bad username!");
    expect(status).toBe(400);
  });
});

describe("Auth: Login", () => {
  const username = `logintest_${Date.now()}`;

  beforeAll(async () => {
    await registerUser(username);
  });

  it("logs in with correct credentials", async () => {
    const fakeKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const fakeSig =
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const { status, body } = await apiRequest("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        version: AUTH_PROTOCOL_VERSION,
        username,
        password: "TestPassword123!",
        device: {
          name: "Login Device",
          identityKeyPublic: fakeKey,
          signingKeyPublic: fakeKey,
          registrationId: 9999,
          signedPreKey: { id: 1, publicKey: fakeKey, signature: fakeSig },
          oneTimePreKeys: [{ id: 1, publicKey: fakeKey }],
        },
      }),
    });
    expect(status).toBe(200);
    const typed = body as { accessToken?: string };
    expect(typeof typed.accessToken).toBe("string");
  });

  it("rejects wrong password", async () => {
    const fakeKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const fakeSig =
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const { status } = await apiRequest("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        version: AUTH_PROTOCOL_VERSION,
        username,
        password: "wrongpassword",
        device: {
          name: "Device",
          identityKeyPublic: fakeKey,
          signingKeyPublic: fakeKey,
          registrationId: 1,
          signedPreKey: { id: 1, publicKey: fakeKey, signature: fakeSig },
          oneTimePreKeys: [{ id: 1, publicKey: fakeKey }],
        },
      }),
    });
    expect(status).toBe(401);
  });

  it("rejects replacing the stored device identity for the same registration id", async () => {
    const continuityUsername = `continuity_${Date.now()}`;
    const originalKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const replacementKey = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const fakeSig =
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const registrationId = 7001;

    const registered = await registerUser(continuityUsername, {
      identityKeyPublic: originalKey,
      signingKeyPublic: originalKey,
      registrationId,
      signedPreKey: {
        id: 1,
        publicKey: originalKey,
        signature: fakeSig,
      },
      oneTimePreKeys: [{ id: 1, publicKey: originalKey }],
    });
    expect(registered.status).toBe(201);

    const { status, body } = await apiRequest("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        version: AUTH_PROTOCOL_VERSION,
        username: continuityUsername,
        password: "TestPassword123!",
        device: {
          name: "Replaced Device",
          identityKeyPublic: replacementKey,
          signingKeyPublic: replacementKey,
          registrationId,
          signedPreKey: {
            id: 2,
            publicKey: replacementKey,
            signature: fakeSig,
          },
          oneTimePreKeys: [{ id: 2, publicKey: replacementKey }],
        },
      }),
    });

    expect(status).toBe(409);
    expect((body as { error?: string }).error).toContain(
      "Stored device identity"
    );
  });

  it("clears refresh cookie when refresh verification fails", async () => {
    const username = `refresh_cookie_${Date.now()}`;
    const fakeKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const fakeSig =
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    const registerResponse = await fetch(`${BASE_URL}/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: AUTH_PROTOCOL_VERSION,
        username,
        password: "TestPassword123!",
        device: {
          name: "Refresh Cookie Test Device",
          identityKeyPublic: fakeKey,
          signingKeyPublic: fakeKey,
          registrationId: Math.floor(Math.random() * 16382) + 1,
          signedPreKey: { id: 1, publicKey: fakeKey, signature: fakeSig },
          oneTimePreKeys: Array.from({ length: 5 }, (_, index) => ({
            id: index + 1,
            publicKey: fakeKey,
          })),
        },
      }),
    });

    expect(registerResponse.status).toBe(201);

    const setCookieHeader = registerResponse.headers.get("set-cookie");
    expect(typeof setCookieHeader).toBe("string");

    const refreshTokenMatch = setCookieHeader?.match(/refresh_token=([^;]+)/);
    expect(refreshTokenMatch?.[1]).toBeTruthy();

    const refreshResponse = await fetch(`${BASE_URL}/auth/refresh`, {
      method: "POST",
      headers: {
        Cookie: `refresh_token=${refreshTokenMatch?.[1] ?? ""}tampered`,
      },
    });

    expect(refreshResponse.status).toBe(401);
    const refreshBody = (await refreshResponse.json()) as { error?: string };
    expect(refreshBody.error).toBe("Invalid or expired refresh token");

    const clearedCookieHeader = refreshResponse.headers.get("set-cookie");
    expect(typeof clearedCookieHeader).toBe("string");
    expect(clearedCookieHeader).toContain("refresh_token=");
    expect(clearedCookieHeader).toMatch(/Max-Age=0|Expires=/);
  });
});

describe("Auth: Background poll tokens", () => {
  it("rejects expired background poll tokens", async () => {
    const username = `bg_expire_${Date.now()}`;
    const registered = await registerUser(username);
    expect(registered.status).toBe(201);
    const registeredBody = registered.body as {
      userId: string;
      deviceId: string;
      accessToken: string;
    };

    const issued = await apiRequest(
      "/auth/background-token",
      { method: "POST" },
      registeredBody.accessToken
    );
    expect(issued.status).toBe(200);
    const issuedBody = issued.body as {
      token?: string;
      expiresAt?: string;
      expiresInSec?: number;
    };
    expect(typeof issuedBody.token).toBe("string");
    expect(typeof issuedBody.expiresAt).toBe("string");
    expect(issuedBody.expiresInSec).toBeGreaterThan(0);

    const beforeExpiry = await apiRequest(
      "/plain/conversations/unread-summary",
      {},
      issuedBody.token
    );
    expect(beforeExpiry.status).toBe(200);

    await query(
      `UPDATE background_poll_tokens
       SET expires_at = now() - INTERVAL '1 second'
       WHERE user_id = $1 AND device_id = $2`,
      [registeredBody.userId, registeredBody.deviceId]
    );

    const afterExpiry = await apiRequest(
      "/plain/conversations/unread-summary",
      {},
      issuedBody.token
    );
    expect(afterExpiry.status).toBe(401);
  });

  it("revokes the current device background poll token on logout", async () => {
    const username = `bg_logout_${Date.now()}`;
    const fakeKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const fakeSig =
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    const registerResponse = await fetch(`${BASE_URL}/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: AUTH_PROTOCOL_VERSION,
        username,
        password: "TestPassword123!",
        device: {
          name: "Background Logout Test Device",
          identityKeyPublic: fakeKey,
          signingKeyPublic: fakeKey,
          registrationId: Math.floor(Math.random() * 16382) + 1,
          signedPreKey: { id: 1, publicKey: fakeKey, signature: fakeSig },
          oneTimePreKeys: Array.from({ length: 5 }, (_, index) => ({
            id: index + 1,
            publicKey: fakeKey,
          })),
        },
      }),
    });
    expect(registerResponse.status).toBe(201);

    const setCookieHeader = registerResponse.headers.get("set-cookie");
    const refreshTokenMatch = setCookieHeader?.match(/refresh_token=([^;]+)/);
    expect(refreshTokenMatch?.[1]).toBeTruthy();

    const registeredBody = (await registerResponse.json()) as {
      accessToken: string;
    };
    const issued = await apiRequest(
      "/auth/background-token",
      { method: "POST" },
      registeredBody.accessToken
    );
    expect(issued.status).toBe(200);
    const pollToken = (issued.body as { token?: string }).token;
    expect(typeof pollToken).toBe("string");

    const beforeLogout = await apiRequest(
      "/plain/conversations/unread-summary",
      {},
      pollToken
    );
    expect(beforeLogout.status).toBe(200);

    const logoutResponse = await fetch(`${BASE_URL}/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: `refresh_token=${refreshTokenMatch?.[1] ?? ""}`,
      },
    });
    expect(logoutResponse.status).toBe(200);

    const afterLogout = await apiRequest(
      "/plain/conversations/unread-summary",
      {},
      pollToken
    );
    expect(afterLogout.status).toBe(401);
  });
});

describe("Protected endpoints require auth", () => {
  it("GET /devices returns 401 without token", async () => {
    const { status } = await apiRequest("/devices");
    expect(status).toBe(401);
  });

  it("GET /messages/pending returns 401 without token", async () => {
    const { status } = await apiRequest("/messages/pending");
    expect(status).toBe(401);
  });

  it("GET /calls/turn-credentials returns 401 without token", async () => {
    const { status } = await apiRequest("/calls/turn-credentials");
    expect(status).toBe(401);
  });
});

describe("Auth: WS ticket hardening", () => {
  it("POST /auth/ws-ticket returns 401 without token", async () => {
    const { status } = await apiRequest("/auth/ws-ticket", { method: "POST" });
    expect(status).toBe(401);
  });

  it("rejects ws-scoped token on regular HTTP routes", async () => {
    const registered = await registerUser(`ws_scope_${Date.now()}`);
    expect(registered.status).toBe(201);
    const accessToken = (registered.body as { accessToken: string })
      .accessToken;

    const wsToken = await issueWsTicket(accessToken);
    const { status } = await apiRequest("/devices", {}, wsToken);
    expect(status).toBe(401);
  });

  it("rejects access JWT in sec-websocket-protocol auth slot", async () => {
    const registered = await registerUser(`ws_proto_${Date.now()}`);
    expect(registered.status).toBe(201);
    const accessToken = (registered.body as { accessToken: string })
      .accessToken;

    const wsUrl = `${BASE_URL.replace(/^http/, "ws")}/ws`;
    const ws = new WebSocket(wsUrl, ["qm.v1", `seclettr.auth.${accessToken}`]);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("WS close timeout")),
        3000
      );
      ws.once("close", (code) => {
        clearTimeout(timeout);
        expect(code).toBe(4001);
        resolve();
      });
      ws.once("error", () => {
        // The server should close with 4001; keep waiting for close.
      });
    });
  });
});

describe("Device management with auth", () => {
  const username = `devtest_${Date.now()}`;
  let token = "";

  beforeAll(async () => {
    const { body } = await registerUser(username);
    token = (body as { accessToken: string }).accessToken;
  });

  it("lists own devices", async () => {
    const { status, body } = await apiRequest("/devices", {}, token);
    expect(status).toBe(200);
    const typed = body as { devices: unknown[] };
    expect(Array.isArray(typed.devices)).toBe(true);
    expect(typed.devices.length).toBeGreaterThan(0);
  });

  it("fetches TURN credentials", async () => {
    const { status, body } = await apiRequest(
      "/calls/turn-credentials",
      {},
      token
    );
    expect(status).toBe(200);
    const typed = body as {
      username?: string;
      password?: string;
      uris?: string[];
    };
    expect(typeof typed.username).toBe("string");
    expect(typeof typed.password).toBe("string");
    expect(typed.uris).toEqual(expectedTurnUris());
  });
});

describe("User device metadata exposure controls", () => {
  let requesterToken = "";
  let requesterUserId = "";
  let targetUserId = "";

  beforeAll(async () => {
    const requester = await registerUser(`dmreq_${Date.now()}`);
    expect(requester.status).toBe(201);
    requesterToken = (requester.body as { accessToken: string }).accessToken;
    requesterUserId = (requester.body as { userId: string }).userId;

    const target = await registerUser(`dmtgt_${Date.now()}`);
    expect(target.status).toBe(201);
    targetUserId = (target.body as { userId: string }).userId;
  });

  it("keeps full device metadata available on the self path", async () => {
    const { status, body } = await apiRequest(
      `/users/${requesterUserId}/devices`,
      {},
      requesterToken
    );
    expect(status).toBe(200);
    const typed = body as {
      devices: Array<{
        deviceId: string;
        name?: string;
        identityKeyPublic?: string;
        signingKeyPublic?: string;
        registrationId?: number;
        createdAt?: string;
      }>;
    };
    expect(typed.devices.length).toBeGreaterThan(0);
    expect(typeof typed.devices[0]?.deviceId).toBe("string");
    expect(typeof typed.devices[0]?.name).toBe("string");
    expect(typeof typed.devices[0]?.identityKeyPublic).toBe("string");
    expect(typeof typed.devices[0]?.signingKeyPublic).toBe("string");
    expect(typeof typed.devices[0]?.registrationId).toBe("number");
    expect(typeof typed.devices[0]?.createdAt).toBe("string");
  });

  it("blocks cross-user device metadata until an explicit relationship exists", async () => {
    const blocked = await apiRequest(
      `/users/${targetUserId}/devices`,
      {},
      requesterToken
    );
    expect(blocked.status).toBe(403);
    expect((blocked.body as { error?: string }).error).toBe(
      "Relationship or contact grant required"
    );

    const relationship = await createDirectRelationship(
      requesterToken,
      targetUserId
    );
    expect(relationship.status).toBe(200);

    const { status, body } = await apiRequest(
      `/users/${targetUserId}/devices`,
      {},
      requesterToken
    );
    expect(status).toBe(200);
    const typed = body as {
      devices: Array<{
        deviceId: string;
        identityKeyPublic?: string;
        signingKeyPublic?: string;
        registrationId?: number;
        name?: string;
        createdAt?: string;
        lastSeenAt?: string;
      }>;
    };
    expect(typed.devices.length).toBeGreaterThan(0);
    expect(typeof typed.devices[0]?.deviceId).toBe("string");
    expect(typeof typed.devices[0]?.identityKeyPublic).toBe("string");
    expect(typeof typed.devices[0]?.signingKeyPublic).toBe("string");
    expect(typed.devices[0]?.registrationId).toBeUndefined();
    expect(typed.devices[0]?.name).toBeUndefined();
    expect(typed.devices[0]?.createdAt).toBeUndefined();
    expect(typed.devices[0]?.lastSeenAt).toBeUndefined();
  });

  it("rate-limits repeated cross-user device metadata lookups", async () => {
    const requester = await registerUser(`dmbreq_${Date.now()}`);
    expect(requester.status).toBe(201);
    const burstRequesterToken = (requester.body as { accessToken: string })
      .accessToken;

    const target = await registerUser(`dmbtgt_${Date.now()}`);
    expect(target.status).toBe(201);
    const burstTargetUserId = (target.body as { userId: string }).userId;

    const relationship = await createDirectRelationship(
      burstRequesterToken,
      burstTargetUserId
    );
    expect(relationship.status).toBe(200);

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const { status } = await apiRequest(
        `/users/${burstTargetUserId}/devices`,
        {},
        burstRequesterToken
      );
      expect(status).toBe(200);
    }

    const { status, body } = await apiRequest(
      `/users/${burstTargetUserId}/devices`,
      {},
      burstRequesterToken
    );
    expect(status).toBe(429);
    expect((body as { error?: string }).error).toBe(
      "Too many device metadata requests"
    );
  });

  it("exposes batch group member device metadata only to active group members", async () => {
    const owner = await registerUser(`gmd_owner_${Date.now()}`);
    expect(owner.status).toBe(201);
    const ownerToken = (owner.body as { accessToken: string }).accessToken;

    const member = await registerUser(`gmd_member_${Date.now()}`);
    expect(member.status).toBe(201);
    const memberUserId = (member.body as { userId: string }).userId;
    const memberDeviceId = (member.body as { deviceId: string }).deviceId;

    const outsider = await registerUser(`gmd_outsider_${Date.now()}`);
    expect(outsider.status).toBe(201);
    const outsiderToken = (outsider.body as { accessToken: string })
      .accessToken;

    const createdGroup = await apiRequest(
      "/groups",
      {
        method: "POST",
        body: JSON.stringify({
          name: `Device Batch ${Date.now()}`,
          memberUserIds: [memberUserId],
        }),
      },
      ownerToken
    );
    expect(createdGroup.status).toBe(201);
    const groupId = (createdGroup.body as { groupId: string }).groupId;

    const ownerView = await apiRequest(
      `/groups/${groupId}/member-devices`,
      {},
      ownerToken
    );
    expect(ownerView.status).toBe(200);
    const parsed = GroupMemberDevicesResponseSchema.safeParse(ownerView.body);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.version).toBe(1);
    expect(
      parsed.data?.members.some(
        (groupMember) =>
          groupMember.userId === memberUserId &&
          groupMember.devices.some(
            (device) =>
              device.deviceId === memberDeviceId &&
              typeof device.signingKeyPublic === "string"
          )
      )
    ).toBe(true);

    const outsiderView = await apiRequest(
      `/groups/${groupId}/member-devices`,
      {},
      outsiderToken
    );
    expect(outsiderView.status).toBe(403);
    expect((outsiderView.body as { error?: string }).error).toBe(
      "Not a group member"
    );
  });
});

describe("Prekey bundle access control", () => {
  it("rejects prekey bundle access until a direct relationship exists", async () => {
    const requester = await registerUser(`prekey_req_${Date.now()}`);
    expect(requester.status).toBe(201);
    const requesterToken = (requester.body as { accessToken: string })
      .accessToken;

    const target = await registerUser(`prekey_tgt_${Date.now()}`);
    expect(target.status).toBe(201);
    const targetUserId = (target.body as { userId: string }).userId;
    const targetDeviceId = (target.body as { deviceId: string }).deviceId;

    const blocked = await apiRequest(
      `/users/${targetUserId}/devices/${targetDeviceId}/prekey-bundle`,
      {},
      requesterToken
    );
    expect(blocked.status).toBe(403);
    expect((blocked.body as { error?: string }).error).toBe(
      "Relationship or contact grant required"
    );

    const relationship = await createDirectRelationship(
      requesterToken,
      targetUserId
    );
    expect(relationship.status).toBe(200);

    const allowed = await apiRequest(
      `/users/${targetUserId}/devices/${targetDeviceId}/prekey-bundle`,
      {},
      requesterToken
    );
    expect(allowed.status).toBe(200);
    expect(
      typeof (allowed.body as { identityKeyPublic?: string }).identityKeyPublic
    ).toBe("string");
  });

  it("does not deplete one-time prekeys below the protected reserve", async () => {
    const requester = await registerUser(`prekey_floor_req_${Date.now()}`);
    expect(requester.status).toBe(201);
    const requesterToken = (requester.body as { accessToken: string })
      .accessToken;

    const target = await registerUser(`prekey_floor_tgt_${Date.now()}`, {
      oneTimePreKeys: Array.from({ length: 7 }, (_, index) => ({
        id: index + 1,
        publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      })),
    });
    expect(target.status).toBe(201);
    const targetUserId = (target.body as { userId: string }).userId;
    const targetDeviceId = (target.body as { deviceId: string }).deviceId;

    const relationship = await createDirectRelationship(
      requesterToken,
      targetUserId
    );
    expect(relationship.status).toBe(200);

    const first = await apiRequest(
      `/users/${targetUserId}/devices/${targetDeviceId}/prekey-bundle`,
      {},
      requesterToken
    );
    expect(first.status).toBe(200);
    expect(
      (first.body as { oneTimePreKey?: { id: number }; otkCount?: number })
        .oneTimePreKey?.id
    ).toBeDefined();
    expect((first.body as { otkCount?: number }).otkCount).toBe(6);

    const second = await apiRequest(
      `/users/${targetUserId}/devices/${targetDeviceId}/prekey-bundle`,
      {},
      requesterToken
    );
    expect(second.status).toBe(200);
    expect(
      (second.body as { oneTimePreKey?: { id: number }; otkCount?: number })
        .oneTimePreKey?.id
    ).toBeDefined();
    expect((second.body as { otkCount?: number }).otkCount).toBe(5);

    const third = await apiRequest(
      `/users/${targetUserId}/devices/${targetDeviceId}/prekey-bundle`,
      {},
      requesterToken
    );
    expect(third.status).toBe(200);
    expect(
      (third.body as { oneTimePreKey?: { id: number }; otkCount?: number })
        .oneTimePreKey
    ).toBeUndefined();
    expect((third.body as { otkCount?: number }).otkCount).toBe(5);
  });
});

describe("Call access contracts", () => {
  let callerToken = "";
  let callerUserId = "";
  let callerDeviceId = "";
  let calleeToken = "";
  let outsiderToken = "";
  let groupOwnerToken = "";
  let groupMemberToken = "";
  let groupOutsiderToken = "";
  let calleeUserId = "";
  let calleeDeviceId = "";
  let groupMemberUserId = "";
  let groupId = "";
  let directCallId = "";
  let groupCallId = "";

  beforeAll(async () => {
    const caller = await registerUser(`call_caller_${Date.now()}`);
    expect(caller.status).toBe(201);
    callerToken = (caller.body as { accessToken: string }).accessToken;
    callerUserId = (caller.body as { userId: string }).userId;
    callerDeviceId = (caller.body as { deviceId: string }).deviceId;

    const callee = await registerUser(`call_callee_${Date.now()}`);
    expect(callee.status).toBe(201);
    calleeToken = (callee.body as { accessToken: string }).accessToken;
    calleeUserId = (callee.body as { userId: string }).userId;
    calleeDeviceId = (callee.body as { deviceId: string }).deviceId;

    const outsider = await registerUser(`call_outsider_${Date.now()}`);
    expect(outsider.status).toBe(201);
    outsiderToken = (outsider.body as { accessToken: string }).accessToken;

    const directCall = await apiRequest(
      "/calls",
      {
        method: "POST",
        body: JSON.stringify({
          calleeUserId,
          callType: "audio",
        }),
      },
      callerToken
    );
    expect(directCall.status).toBe(200);
    directCallId = (directCall.body as { callId: string }).callId;

    const groupOwner = await registerUser(`group_call_owner_${Date.now()}`);
    expect(groupOwner.status).toBe(201);
    groupOwnerToken = (groupOwner.body as { accessToken: string }).accessToken;

    const groupMember = await registerUser(`group_call_member_${Date.now()}`);
    expect(groupMember.status).toBe(201);
    groupMemberToken = (groupMember.body as { accessToken: string })
      .accessToken;
    groupMemberUserId = (groupMember.body as { userId: string }).userId;

    const groupOutsider = await registerUser(`gco_${Date.now().toString(36)}`);
    expect(groupOutsider.status).toBe(201);
    groupOutsiderToken = (groupOutsider.body as { accessToken: string })
      .accessToken;

    const createdGroup = await apiRequest(
      "/groups",
      {
        method: "POST",
        body: JSON.stringify({
          name: `Call Group ${Date.now()}`,
          memberUserIds: [groupMemberUserId],
        }),
      },
      groupOwnerToken
    );
    expect(createdGroup.status).toBe(201);
    groupId = (createdGroup.body as { groupId: string }).groupId;

    const groupCall = await apiRequest(
      "/calls",
      {
        method: "POST",
        body: JSON.stringify({
          groupId,
          callType: "video",
        }),
      },
      groupOwnerToken
    );
    expect(groupCall.status).toBe(200);
    groupCallId = (groupCall.body as { callId: string }).callId;
  });

  it("allows direct call participants to query SFU access", async () => {
    const callerAccess = await apiRequest(
      `/calls/${directCallId}/sfu-access`,
      {},
      callerToken
    );
    expect(callerAccess.status).toBe(200);
    expect((callerAccess.body as { ok?: boolean }).ok).toBe(true);

    const calleeAccess = await apiRequest(
      `/calls/${directCallId}/sfu-access`,
      {},
      calleeToken
    );
    expect(calleeAccess.status).toBe(200);
    expect((calleeAccess.body as { ok?: boolean }).ok).toBe(true);
  });

  it("rejects direct call access for non-participants", async () => {
    const outsiderAccess = await apiRequest(
      `/calls/${directCallId}/sfu-access`,
      {},
      outsiderToken
    );
    expect(outsiderAccess.status).toBe(403);
    expect((outsiderAccess.body as { error?: string }).error).toBe("Forbidden");
  });

  it("rejects forged call auth context before forwarding offer SDP", async () => {
    const callerWs = await openAuthedWebSocket(callerToken);
    const calleeWs = await openAuthedWebSocket(calleeToken);
    const forgedCallId = crypto.randomUUID();

    try {
      callerWs.send(
        JSON.stringify({
          type: "call.offer",
          callId: forgedCallId,
          targetUserId: calleeUserId,
          callType: "audio",
          sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
          auth: {
            version: 1,
            senderUserId: callerUserId,
            senderDeviceId: crypto.randomUUID(),
            recipientUserId: calleeUserId,
            signedAt: new Date().toISOString(),
            sdpHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            signature: "forged-call-auth",
          },
        })
      );

      const rejection = await waitForWsMessage(
        callerWs,
        (msg) => msg.type === "error" && msg.code === "INVALID_CALL_AUTH"
      );
      expect(rejection.type).toBe("error");
      if (rejection.type !== "error") {
        throw new Error("Expected INVALID_CALL_AUTH websocket error");
      }
      expect(rejection.reason).toBe("context_mismatch");

      await new Promise((resolve) => setTimeout(resolve, 200));
      const leakedOffer = takeQueuedWsMessage(
        calleeWs,
        (msg) => msg.type === "call.offer" && msg.callId === forgedCallId
      );
      expect(leakedOffer).toBeNull();

      const currentCallAccess = await apiRequest(
        `/calls/${directCallId}/sfu-access`,
        {},
        calleeToken
      );
      expect(currentCallAccess.status).toBe(200);

      const selfDevices = await apiRequest(
        `/users/${calleeUserId}/devices`,
        {},
        calleeToken
      );
      expect(selfDevices.status).toBe(200);
      expect(
        (
          selfDevices.body as { devices: Array<{ deviceId: string }> }
        ).devices.some((device) => device.deviceId === calleeDeviceId)
      ).toBe(true);

      const callerDevices = await apiRequest(
        `/users/${callerUserId}/devices`,
        {},
        calleeToken
      );
      expect(callerDevices.status).toBe(200);
      expect(
        (
          callerDevices.body as {
            devices: Array<{ deviceId: string; signingKeyPublic?: string }>;
          }
        ).devices.some(
          (device) =>
            device.deviceId === callerDeviceId &&
            typeof device.signingKeyPublic === "string"
        )
      ).toBe(true);
    } finally {
      callerWs.close();
      calleeWs.close();
    }
  });

  it("forwards direct-call offers only when the detached auth proof is cryptographically valid", async () => {
    const sodium = await ensureSodium();
    const signer = sodium.crypto_sign_keypair();
    const caller = await registerUser(`authsig_caller_${Date.now()}`, {
      signingKeyPublic: toBase64Url(signer.publicKey),
    });
    expect(caller.status).toBe(201);
    const callerTokenWithProof = (caller.body as { accessToken: string })
      .accessToken;
    const callerUserIdWithProof = (caller.body as { userId: string }).userId;
    const callerDeviceIdWithProof = (caller.body as { deviceId: string })
      .deviceId;

    const callee = await registerUser(`authsig_callee_${Date.now()}`);
    expect(callee.status).toBe(201);
    const calleeTokenWithProof = (callee.body as { accessToken: string })
      .accessToken;
    const calleeUserIdWithProof = (callee.body as { userId: string }).userId;

    const callerWs = await openAuthedWebSocket(callerTokenWithProof);
    const calleeWs = await openAuthedWebSocket(calleeTokenWithProof);
    const callId = await createDirectCallId(
      callerTokenWithProof,
      calleeUserIdWithProof,
      "video"
    );
    const sdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
    const signedAt = new Date().toISOString();
    const sdpHash = hashCallSdp(sdp);
    const signature = toBase64Url(
      sodium.crypto_sign_detached(
        buildOfferCallAuthMaterial({
          callId,
          senderUserId: callerUserIdWithProof,
          senderDeviceId: callerDeviceIdWithProof,
          recipientUserId: calleeUserIdWithProof,
          callType: "video",
          signedAt,
          sdpHash,
        }),
        signer.privateKey
      )
    );

    try {
      callerWs.send(
        JSON.stringify({
          type: "call.offer",
          callId,
          targetUserId: calleeUserIdWithProof,
          callType: "video",
          sdp,
          auth: {
            version: 1,
            senderUserId: callerUserIdWithProof,
            senderDeviceId: callerDeviceIdWithProof,
            recipientUserId: calleeUserIdWithProof,
            signedAt,
            sdpHash,
            signature,
          },
        })
      );

      const forwardedOffer = await waitForWsMessage(
        calleeWs,
        (msg) => msg.type === "call.offer" && msg.callId === callId
      );
      expect(forwardedOffer.type).toBe("call.offer");
    } finally {
      callerWs.close();
      calleeWs.close();
    }
  });

  it("rejects replayed direct-call offers with the same detached auth proof", async () => {
    const sodium = await ensureSodium();
    const signer = sodium.crypto_sign_keypair();
    const caller = await registerUser(`authreplay_caller_${Date.now()}`, {
      signingKeyPublic: toBase64Url(signer.publicKey),
    });
    expect(caller.status).toBe(201);
    const callerTokenWithProof = (caller.body as { accessToken: string })
      .accessToken;
    const callerUserIdWithProof = (caller.body as { userId: string }).userId;
    const callerDeviceIdWithProof = (caller.body as { deviceId: string })
      .deviceId;

    const callee = await registerUser(`authreplay_callee_${Date.now()}`);
    expect(callee.status).toBe(201);
    const calleeTokenWithProof = (callee.body as { accessToken: string })
      .accessToken;
    const calleeUserIdWithProof = (callee.body as { userId: string }).userId;

    const callerWs = await openAuthedWebSocket(callerTokenWithProof);
    const calleeWs = await openAuthedWebSocket(calleeTokenWithProof);
    const callId = await createDirectCallId(
      callerTokenWithProof,
      calleeUserIdWithProof,
      "audio"
    );
    const sdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
    const signedAt = new Date().toISOString();
    const sdpHash = hashCallSdp(sdp);
    const signature = toBase64Url(
      sodium.crypto_sign_detached(
        buildOfferCallAuthMaterial({
          callId,
          senderUserId: callerUserIdWithProof,
          senderDeviceId: callerDeviceIdWithProof,
          recipientUserId: calleeUserIdWithProof,
          callType: "audio",
          signedAt,
          sdpHash,
        }),
        signer.privateKey
      )
    );
    const message = {
      type: "call.offer" as const,
      callId,
      targetUserId: calleeUserIdWithProof,
      callType: "audio" as const,
      sdp,
      auth: {
        version: 1 as const,
        senderUserId: callerUserIdWithProof,
        senderDeviceId: callerDeviceIdWithProof,
        recipientUserId: calleeUserIdWithProof,
        signedAt,
        sdpHash,
        signature,
      },
    };

    try {
      callerWs.send(JSON.stringify(message));

      const forwardedOffer = await waitForWsMessage(
        calleeWs,
        (msg) => msg.type === "call.offer" && msg.callId === callId
      );
      expect(forwardedOffer.type).toBe("call.offer");

      callerWs.send(JSON.stringify(message));

      const rejection = await waitForWsMessage(
        callerWs,
        (msg) =>
          msg.type === "error" &&
          msg.code === "INVALID_CALL_AUTH" &&
          msg.message === "Call auth proof already used"
      );
      expect(rejection.type).toBe("error");
      if (rejection.type !== "error") {
        throw new Error("Expected INVALID_CALL_AUTH websocket error");
      }
      expect(rejection.reason).toBe("replayed_call_auth");

      await new Promise((resolve) => setTimeout(resolve, 200));
      const duplicatedOffer = takeQueuedWsMessage(
        calleeWs,
        (msg) => msg.type === "call.offer" && msg.callId === callId
      );
      expect(duplicatedOffer).toBeNull();
    } finally {
      callerWs.close();
      calleeWs.close();
    }
  });

  it("rejects direct-call offers with forged detached auth proof even when context matches", async () => {
    const sodium = await ensureSodium();
    const signer = sodium.crypto_sign_keypair();
    const stranger = sodium.crypto_sign_keypair();
    const caller = await registerUser(`authforge_caller_${Date.now()}`, {
      signingKeyPublic: toBase64Url(signer.publicKey),
    });
    expect(caller.status).toBe(201);
    const callerTokenWithProof = (caller.body as { accessToken: string })
      .accessToken;
    const callerUserIdWithProof = (caller.body as { userId: string }).userId;
    const callerDeviceIdWithProof = (caller.body as { deviceId: string })
      .deviceId;

    const callee = await registerUser(`authforge_callee_${Date.now()}`);
    expect(callee.status).toBe(201);
    const calleeTokenWithProof = (callee.body as { accessToken: string })
      .accessToken;
    const calleeUserIdWithProof = (callee.body as { userId: string }).userId;

    const callerWs = await openAuthedWebSocket(callerTokenWithProof);
    const calleeWs = await openAuthedWebSocket(calleeTokenWithProof);
    const callId = await createDirectCallId(
      callerTokenWithProof,
      calleeUserIdWithProof,
      "audio"
    );
    const sdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
    const signedAt = new Date().toISOString();
    const sdpHash = hashCallSdp(sdp);
    const signature = toBase64Url(
      sodium.crypto_sign_detached(
        buildOfferCallAuthMaterial({
          callId,
          senderUserId: callerUserIdWithProof,
          senderDeviceId: callerDeviceIdWithProof,
          recipientUserId: calleeUserIdWithProof,
          callType: "audio",
          signedAt,
          sdpHash,
        }),
        stranger.privateKey
      )
    );

    try {
      callerWs.send(
        JSON.stringify({
          type: "call.offer",
          callId,
          targetUserId: calleeUserIdWithProof,
          callType: "audio",
          sdp,
          auth: {
            version: 1,
            senderUserId: callerUserIdWithProof,
            senderDeviceId: callerDeviceIdWithProof,
            recipientUserId: calleeUserIdWithProof,
            signedAt,
            sdpHash,
            signature,
          },
        })
      );

      const rejection = await waitForWsMessage(
        callerWs,
        (msg) => msg.type === "error" && msg.code === "INVALID_CALL_AUTH"
      );
      expect(rejection.type).toBe("error");
      if (rejection.type !== "error") {
        throw new Error("Expected INVALID_CALL_AUTH websocket error");
      }
      expect(rejection.reason).toBe("signature_verification_failed");

      await new Promise((resolve) => setTimeout(resolve, 200));
      const leakedOffer = takeQueuedWsMessage(
        calleeWs,
        (msg) => msg.type === "call.offer" && msg.callId === callId
      );
      expect(leakedOffer).toBeNull();
    } finally {
      callerWs.close();
      calleeWs.close();
    }
  });

  it("forwards call media-encryption negotiation fields through offer/answer signaling", async () => {
    const sodium = await ensureSodium();
    const callerSigner = sodium.crypto_sign_keypair();
    const calleeSigner = sodium.crypto_sign_keypair();
    const caller = await registerUser(`mediaenc_caller_${Date.now()}`, {
      signingKeyPublic: toBase64Url(callerSigner.publicKey),
    });
    expect(caller.status).toBe(201);
    const callerTokenWithProof = (caller.body as { accessToken: string })
      .accessToken;
    const callerUserIdWithProof = (caller.body as { userId: string }).userId;
    const callerDeviceIdWithProof = (caller.body as { deviceId: string })
      .deviceId;

    const callee = await registerUser(`mediaenc_callee_${Date.now()}`, {
      signingKeyPublic: toBase64Url(calleeSigner.publicKey),
    });
    expect(callee.status).toBe(201);
    const calleeTokenWithProof = (callee.body as { accessToken: string })
      .accessToken;
    const calleeUserIdWithProof = (callee.body as { userId: string }).userId;
    const calleeDeviceIdWithProof = (callee.body as { deviceId: string })
      .deviceId;

    const callerWs = await openAuthedWebSocket(callerTokenWithProof);
    const calleeWs = await openAuthedWebSocket(calleeTokenWithProof);
    const callId = await createDirectCallId(
      callerTokenWithProof,
      calleeUserIdWithProof,
      "video"
    );
    const offerSdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
    const offerSignedAt = new Date().toISOString();
    const offerSdpHash = hashCallSdp(offerSdp);
    const offerSignature = toBase64Url(
      sodium.crypto_sign_detached(
        buildOfferCallAuthMaterial({
          callId,
          senderUserId: callerUserIdWithProof,
          senderDeviceId: callerDeviceIdWithProof,
          recipientUserId: calleeUserIdWithProof,
          callType: "video",
          signedAt: offerSignedAt,
          sdpHash: offerSdpHash,
          mediaEncryptionPreferredMode: "transport",
          mediaEncryptionSupportedModesCsv: "transport",
        }),
        callerSigner.privateKey
      )
    );

    try {
      callerWs.send(
        JSON.stringify({
          type: "call.offer",
          callId,
          targetUserId: calleeUserIdWithProof,
          callType: "video",
          sdp: offerSdp,
          mediaEncryption: {
            preferredMode: "transport",
            supportedModes: ["transport"],
          },
          auth: {
            version: 1,
            senderUserId: callerUserIdWithProof,
            senderDeviceId: callerDeviceIdWithProof,
            recipientUserId: calleeUserIdWithProof,
            signedAt: offerSignedAt,
            sdpHash: offerSdpHash,
            signature: offerSignature,
          },
        })
      );

      const offer = await waitForWsMessage(
        calleeWs,
        (msg) => msg.type === "call.offer" && msg.callId === callId
      );
      expect(offer.type).toBe("call.offer");
      if (offer.type === "call.offer") {
        const offerWithMedia = offer as typeof offer & {
          mediaEncryption?: {
            preferredMode: "transport" | "frame-v1";
            supportedModes: Array<"transport" | "frame-v1">;
          };
        };
        expect(offerWithMedia.mediaEncryption).toEqual({
          preferredMode: "transport",
          supportedModes: ["transport"],
        });
      }

      const answerSdp = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
      const answerSignedAt = new Date().toISOString();
      const answerSdpHash = hashCallSdp(answerSdp);
      const answerSignature = toBase64Url(
        sodium.crypto_sign_detached(
          buildAnswerCallAuthMaterial({
            callId,
            senderUserId: calleeUserIdWithProof,
            senderDeviceId: calleeDeviceIdWithProof,
            recipientUserId: callerUserIdWithProof,
            signedAt: answerSignedAt,
            sdpHash: answerSdpHash,
            mediaEncryptionSelectedMode: "transport",
            mediaEncryptionSupportedModesCsv: "transport",
          }),
          calleeSigner.privateKey
        )
      );

      calleeWs.send(
        JSON.stringify({
          type: "call.answer",
          callId,
          sdp: answerSdp,
          mediaEncryption: {
            selectedMode: "transport",
            supportedModes: ["transport"],
          },
          auth: {
            version: 1,
            senderUserId: calleeUserIdWithProof,
            senderDeviceId: calleeDeviceIdWithProof,
            recipientUserId: callerUserIdWithProof,
            signedAt: answerSignedAt,
            sdpHash: answerSdpHash,
            signature: answerSignature,
          },
        })
      );

      const answered = await waitForWsMessage(
        callerWs,
        (msg) => msg.type === "call.answered" && msg.callId === callId
      );
      expect(answered.type).toBe("call.answered");
      if (answered.type === "call.answered") {
        const answeredWithMedia = answered as typeof answered & {
          mediaEncryption?: {
            selectedMode: "transport" | "frame-v1";
            supportedModes: Array<"transport" | "frame-v1">;
          };
        };
        expect(answeredWithMedia.mediaEncryption).toEqual({
          selectedMode: "transport",
          supportedModes: ["transport"],
        });
      }
      await waitFor(async () => {
        const persisted = await loadPersistedCallSession(callId);
        return persisted?.status === "active" && persisted.answered_at !== null;
      });

      callerWs.send(
        JSON.stringify({
          type: "call.hangup",
          callId,
        })
      );
      await waitFor(async () => {
        const persisted = await loadPersistedCallSession(callId);
        return persisted?.status === "ended" && persisted.ended_at !== null;
      });
    } finally {
      callerWs.close();
      calleeWs.close();
    }
  });

  it("rejects direct-call answers from devices outside the invited callee identity", async () => {
    const sodium = await ensureSodium();
    const callerSigner = sodium.crypto_sign_keypair();
    const outsiderSigner = sodium.crypto_sign_keypair();
    const caller = await registerUser(`dga_c_${Date.now().toString(36)}`, {
      signingKeyPublic: toBase64Url(callerSigner.publicKey),
    });
    expect(caller.status).toBe(201);
    const callerToken = (caller.body as { accessToken: string }).accessToken;
    const callerUserId = (caller.body as { userId: string }).userId;
    const callerDeviceId = (caller.body as { deviceId: string }).deviceId;

    const callee = await registerUser(`dga_t_${Date.now().toString(36)}`);
    expect(callee.status).toBe(201);
    const calleeToken = (callee.body as { accessToken: string }).accessToken;
    const calleeUserId = (callee.body as { userId: string }).userId;

    const outsider = await registerUser(`dga_o_${Date.now().toString(36)}`, {
      signingKeyPublic: toBase64Url(outsiderSigner.publicKey),
    });
    expect(outsider.status).toBe(201);
    const outsiderToken = (outsider.body as { accessToken: string })
      .accessToken;
    const outsiderUserId = (outsider.body as { userId: string }).userId;
    const outsiderDeviceId = (outsider.body as { deviceId: string }).deviceId;

    const callerWs = await openAuthedWebSocket(callerToken);
    const calleeWs = await openAuthedWebSocket(calleeToken);
    const outsiderWs = await openAuthedWebSocket(outsiderToken);
    const callId = await createDirectCallId(callerToken, calleeUserId, "audio");
    const offerSdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
    const offerSignedAt = new Date().toISOString();
    const offerSdpHash = hashCallSdp(offerSdp);
    const offerSignature = toBase64Url(
      sodium.crypto_sign_detached(
        buildOfferCallAuthMaterial({
          callId,
          senderUserId: callerUserId,
          senderDeviceId: callerDeviceId,
          recipientUserId: calleeUserId,
          callType: "audio",
          signedAt: offerSignedAt,
          sdpHash: offerSdpHash,
        }),
        callerSigner.privateKey
      )
    );

    try {
      callerWs.send(
        JSON.stringify({
          type: "call.offer",
          callId,
          targetUserId: calleeUserId,
          callType: "audio",
          sdp: offerSdp,
          auth: {
            version: 1,
            senderUserId: callerUserId,
            senderDeviceId: callerDeviceId,
            recipientUserId: calleeUserId,
            signedAt: offerSignedAt,
            sdpHash: offerSdpHash,
            signature: offerSignature,
          },
        })
      );

      const offer = await waitForWsMessage(
        calleeWs,
        (msg) => msg.type === "call.offer" && msg.callId === callId
      );
      expect(offer.type).toBe("call.offer");

      const answerSdp = "v=0\r\no=- 5 5 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
      const answerSignedAt = new Date().toISOString();
      const answerSdpHash = hashCallSdp(answerSdp);
      const answerSignature = toBase64Url(
        sodium.crypto_sign_detached(
          buildAnswerCallAuthMaterial({
            callId,
            senderUserId: outsiderUserId,
            senderDeviceId: outsiderDeviceId,
            recipientUserId: callerUserId,
            signedAt: answerSignedAt,
            sdpHash: answerSdpHash,
          }),
          outsiderSigner.privateKey
        )
      );

      outsiderWs.send(
        JSON.stringify({
          type: "call.answer",
          callId,
          sdp: answerSdp,
          auth: {
            version: 1,
            senderUserId: outsiderUserId,
            senderDeviceId: outsiderDeviceId,
            recipientUserId: callerUserId,
            signedAt: answerSignedAt,
            sdpHash: answerSdpHash,
            signature: answerSignature,
          },
        })
      );

      const rejection = await waitForWsMessage(
        outsiderWs,
        (msg) =>
          msg.type === "error" && msg.code === "CALL_PARTICIPANT_FORBIDDEN"
      );
      expect(rejection.type).toBe("error");

      await new Promise((resolve) => setTimeout(resolve, 200));
      const leakedAnswer = takeQueuedWsMessage(
        callerWs,
        (msg) => msg.type === "call.answered" && msg.callId === callId
      );
      expect(leakedAnswer).toBeNull();

      callerWs.send(
        JSON.stringify({
          type: "call.hangup",
          callId,
        })
      );
    } finally {
      callerWs.close();
      calleeWs.close();
      outsiderWs.close();
    }
  });

  it("rejects direct-call media state from stale sibling devices after callee binding", async () => {
    const sodium = await ensureSodium();
    const callerSigner = sodium.crypto_sign_keypair();
    const calleeSigner = sodium.crypto_sign_keypair();
    const caller = await registerUser(`dms_c_${Date.now().toString(36)}`, {
      signingKeyPublic: toBase64Url(callerSigner.publicKey),
    });
    expect(caller.status).toBe(201);
    const callerToken = (caller.body as { accessToken: string }).accessToken;
    const callerUserId = (caller.body as { userId: string }).userId;
    const callerDeviceId = (caller.body as { deviceId: string }).deviceId;

    const calleeUsername = `dms_t_${Date.now().toString(36)}`;
    const callee = await registerUser(calleeUsername, {
      signingKeyPublic: toBase64Url(calleeSigner.publicKey),
    });
    expect(callee.status).toBe(201);
    const calleeToken = (callee.body as { accessToken: string }).accessToken;
    const calleeUserId = (callee.body as { userId: string }).userId;
    const calleeDeviceId = (callee.body as { deviceId: string }).deviceId;

    const fakeKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const fakeSig =
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const siblingLogin = await apiRequest("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        version: AUTH_PROTOCOL_VERSION,
        username: calleeUsername,
        password: "TestPassword123!",
        device: {
          name: "Direct Call Sibling Device",
          identityKeyPublic: fakeKey,
          signingKeyPublic: fakeKey,
          registrationId: 7788,
          signedPreKey: { id: 1, publicKey: fakeKey, signature: fakeSig },
          oneTimePreKeys: [{ id: 1, publicKey: fakeKey }],
        },
      }),
    });
    expect(siblingLogin.status).toBe(200);
    const siblingToken = (siblingLogin.body as { accessToken: string })
      .accessToken;
    const siblingDeviceId = (siblingLogin.body as { deviceId: string })
      .deviceId;

    const callerWs = await openAuthedWebSocket(callerToken);
    const calleeWs = await openAuthedWebSocket(calleeToken);
    const siblingWs = await openAuthedWebSocket(siblingToken);
    const callId = await createDirectCallId(callerToken, calleeUserId, "video");
    const offerSdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
    const offerSignedAt = new Date().toISOString();
    const offerSdpHash = hashCallSdp(offerSdp);
    const offerSignature = toBase64Url(
      sodium.crypto_sign_detached(
        buildOfferCallAuthMaterial({
          callId,
          senderUserId: callerUserId,
          senderDeviceId: callerDeviceId,
          recipientUserId: calleeUserId,
          callType: "video",
          signedAt: offerSignedAt,
          sdpHash: offerSdpHash,
        }),
        callerSigner.privateKey
      )
    );

    try {
      callerWs.send(
        JSON.stringify({
          type: "call.offer",
          callId,
          targetUserId: calleeUserId,
          callType: "video",
          sdp: offerSdp,
          auth: {
            version: 1,
            senderUserId: callerUserId,
            senderDeviceId: callerDeviceId,
            recipientUserId: calleeUserId,
            signedAt: offerSignedAt,
            sdpHash: offerSdpHash,
            signature: offerSignature,
          },
        })
      );

      const calleeOffer = await waitForWsMessage(
        calleeWs,
        (msg) => msg.type === "call.offer" && msg.callId === callId
      );
      expect(calleeOffer.type).toBe("call.offer");

      const siblingOffer = await waitForWsMessage(
        siblingWs,
        (msg) => msg.type === "call.offer" && msg.callId === callId
      );
      expect(siblingOffer.type).toBe("call.offer");

      const answerSdp = "v=0\r\no=- 6 6 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
      const answerSignedAt = new Date().toISOString();
      const answerSdpHash = hashCallSdp(answerSdp);
      const answerSignature = toBase64Url(
        sodium.crypto_sign_detached(
          buildAnswerCallAuthMaterial({
            callId,
            senderUserId: calleeUserId,
            senderDeviceId: calleeDeviceId,
            recipientUserId: callerUserId,
            signedAt: answerSignedAt,
            sdpHash: answerSdpHash,
          }),
          calleeSigner.privateKey
        )
      );

      calleeWs.send(
        JSON.stringify({
          type: "call.answer",
          callId,
          sdp: answerSdp,
          auth: {
            version: 1,
            senderUserId: calleeUserId,
            senderDeviceId: calleeDeviceId,
            recipientUserId: callerUserId,
            signedAt: answerSignedAt,
            sdpHash: answerSdpHash,
            signature: answerSignature,
          },
        })
      );

      const answered = await waitForWsMessage(
        callerWs,
        (msg) => msg.type === "call.answered" && msg.callId === callId
      );
      expect(answered.type).toBe("call.answered");

      siblingWs.send(
        JSON.stringify({
          type: "call.media_state",
          callId,
          source: "camera",
          state: "on",
          activity: "active",
          seq: 1,
          streamRevision: 1,
        })
      );

      const rejection = await waitForWsMessage(
        siblingWs,
        (msg) =>
          msg.type === "error" && msg.code === "CALL_PARTICIPANT_FORBIDDEN"
      );
      expect(rejection.type).toBe("error");

      await new Promise((resolve) => setTimeout(resolve, 200));
      const leakedMediaState = takeQueuedWsMessage(
        callerWs,
        (msg) =>
          msg.type === "call.media_state" &&
          msg.callId === callId &&
          msg.senderDeviceId === siblingDeviceId
      );
      expect(leakedMediaState).toBeNull();

      callerWs.send(
        JSON.stringify({
          type: "call.hangup",
          callId,
        })
      );
    } finally {
      callerWs.close();
      calleeWs.close();
      siblingWs.close();
    }
  });

  it("replays a pending direct-call offer when the invited callee device reconnects", async () => {
    const sodium = await ensureSodium();
    const callerSigner = sodium.crypto_sign_keypair();
    const caller = await registerUser(`dcr_c_${Date.now().toString(36)}`, {
      signingKeyPublic: toBase64Url(callerSigner.publicKey),
    });
    expect(caller.status).toBe(201);
    const callerToken = (caller.body as { accessToken: string }).accessToken;
    const callerUserId = (caller.body as { userId: string }).userId;
    const callerDeviceId = (caller.body as { deviceId: string }).deviceId;

    const callee = await registerUser(`dcr_t_${Date.now().toString(36)}`);
    expect(callee.status).toBe(201);
    const calleeToken = (callee.body as { accessToken: string }).accessToken;
    const calleeUserId = (callee.body as { userId: string }).userId;

    const callerWs = await openAuthedWebSocket(callerToken);
    let calleeWs = await openAuthedWebSocket(calleeToken);
    const callId = await createDirectCallId(callerToken, calleeUserId, "audio");
    const offerSdp = "v=0\r\no=- 7 7 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
    const offerSignedAt = new Date().toISOString();
    const offerSdpHash = hashCallSdp(offerSdp);
    const offerSignature = toBase64Url(
      sodium.crypto_sign_detached(
        buildOfferCallAuthMaterial({
          callId,
          senderUserId: callerUserId,
          senderDeviceId: callerDeviceId,
          recipientUserId: calleeUserId,
          callType: "audio",
          signedAt: offerSignedAt,
          sdpHash: offerSdpHash,
        }),
        callerSigner.privateKey
      )
    );

    try {
      await new Promise<void>((resolve) => {
        calleeWs.once("close", () => resolve());
        calleeWs.close();
      });

      callerWs.send(
        JSON.stringify({
          type: "call.offer",
          callId,
          targetUserId: calleeUserId,
          callType: "audio",
          sdp: offerSdp,
          auth: {
            version: 1,
            senderUserId: callerUserId,
            senderDeviceId: callerDeviceId,
            recipientUserId: calleeUserId,
            signedAt: offerSignedAt,
            sdpHash: offerSdpHash,
            signature: offerSignature,
          },
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 150));

      calleeWs = await openAuthedWebSocket(calleeToken);
      const replayedOffer = await waitForWsMessage(
        calleeWs,
        (msg) => msg.type === "call.offer" && msg.callId === callId,
        5_000
      );
      expect(replayedOffer.type).toBe("call.offer");
      if (replayedOffer.type === "call.offer") {
        expect(replayedOffer.callerUserId).toBe(callerUserId);
        expect(replayedOffer.callerDeviceId).toBe(callerDeviceId);
        expect(replayedOffer.targetUserId).toBe(calleeUserId);
        expect(replayedOffer.callType).toBe("audio");
        expect(replayedOffer.sdp).toBe(offerSdp);
      }

      callerWs.send(
        JSON.stringify({
          type: "call.hangup",
          callId,
        })
      );
    } finally {
      callerWs.close();
      calleeWs.close();
    }
  });

  it("keeps a ringing direct-call offer recoverable after the invited callee device stays disconnected past the grace timeout", async () => {
    const sodium = await ensureSodium();
    const callerSigner = sodium.crypto_sign_keypair();
    const caller = await registerUser(`dcrg_c_${Date.now().toString(36)}`, {
      signingKeyPublic: toBase64Url(callerSigner.publicKey),
    });
    expect(caller.status).toBe(201);
    const callerToken = (caller.body as { accessToken: string }).accessToken;
    const callerUserId = (caller.body as { userId: string }).userId;
    const callerDeviceId = (caller.body as { deviceId: string }).deviceId;

    const callee = await registerUser(`dcrg_t_${Date.now().toString(36)}`);
    expect(callee.status).toBe(201);
    const calleeToken = (callee.body as { accessToken: string }).accessToken;
    const calleeUserId = (callee.body as { userId: string }).userId;

    const callerWs = await openAuthedWebSocket(callerToken);
    let calleeWs = await openAuthedWebSocket(calleeToken);
    const callId = await createDirectCallId(callerToken, calleeUserId, "audio");
    const offerSdp = "v=0\r\no=- 8 8 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
    const offerSignedAt = new Date().toISOString();
    const offerSdpHash = hashCallSdp(offerSdp);
    const offerSignature = toBase64Url(
      sodium.crypto_sign_detached(
        buildOfferCallAuthMaterial({
          callId,
          senderUserId: callerUserId,
          senderDeviceId: callerDeviceId,
          recipientUserId: calleeUserId,
          callType: "audio",
          signedAt: offerSignedAt,
          sdpHash: offerSdpHash,
        }),
        callerSigner.privateKey
      )
    );

    try {
      await new Promise<void>((resolve) => {
        calleeWs.once("close", () => resolve());
        calleeWs.close();
      });

      callerWs.send(
        JSON.stringify({
          type: "call.offer",
          callId,
          targetUserId: calleeUserId,
          callType: "audio",
          sdp: offerSdp,
          auth: {
            version: 1,
            senderUserId: callerUserId,
            senderDeviceId: callerDeviceId,
            recipientUserId: calleeUserId,
            signedAt: offerSignedAt,
            sdpHash: offerSdpHash,
            signature: offerSignature,
          },
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 10_750));
      await expect(
        waitForWsMessage(
          callerWs,
          (msg) => msg.type === "call.hangup" && msg.callId === callId,
          300
        )
      ).rejects.toThrow("WS message timeout");

      calleeWs = await openAuthedWebSocket(calleeToken);
      const replayedOffer = await waitForWsMessage(
        calleeWs,
        (msg) => msg.type === "call.offer" && msg.callId === callId,
        5_000
      );
      expect(replayedOffer.type).toBe("call.offer");
      if (replayedOffer.type === "call.offer") {
        expect(replayedOffer.callerUserId).toBe(callerUserId);
        expect(replayedOffer.callerDeviceId).toBe(callerDeviceId);
        expect(replayedOffer.targetUserId).toBe(calleeUserId);
        expect(replayedOffer.callType).toBe("audio");
        expect(replayedOffer.sdp).toBe(offerSdp);
      }

      callerWs.send(
        JSON.stringify({
          type: "call.hangup",
          callId,
        })
      );
    } finally {
      callerWs.close();
      calleeWs.close();
    }
  });

  it("terminates a direct-call routing session through the direct-hangup endpoint", async () => {
    const sodium = await ensureSodium();
    const callerSigner = sodium.crypto_sign_keypair();
    const caller = await registerUser(`dhu_c_${Date.now().toString(36)}`, {
      signingKeyPublic: toBase64Url(callerSigner.publicKey),
    });
    expect(caller.status).toBe(201);
    const callerTokenWithProof = (caller.body as { accessToken: string })
      .accessToken;
    const callerUserIdWithProof = (caller.body as { userId: string }).userId;
    const callerDeviceIdWithProof = (caller.body as { deviceId: string })
      .deviceId;

    const callee = await registerUser(`dhu_d_${Date.now().toString(36)}`);
    expect(callee.status).toBe(201);
    const calleeTokenWithProof = (callee.body as { accessToken: string })
      .accessToken;
    const calleeUserIdWithProof = (callee.body as { userId: string }).userId;

    const createCallResponse = await apiRequest(
      "/calls",
      {
        method: "POST",
        body: JSON.stringify({
          calleeUserId: calleeUserIdWithProof,
          callType: "audio",
        }),
      },
      callerTokenWithProof
    );
    expect(createCallResponse.status).toBe(200);
    const callId = (createCallResponse.body as { callId: string }).callId;

    const callerWs = await openAuthedWebSocket(callerTokenWithProof);
    const calleeWs = await openAuthedWebSocket(calleeTokenWithProof);
    const offerSdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
    const signedAt = new Date().toISOString();
    const sdpHash = hashCallSdp(offerSdp);
    const signature = toBase64Url(
      sodium.crypto_sign_detached(
        buildOfferCallAuthMaterial({
          callId,
          senderUserId: callerUserIdWithProof,
          senderDeviceId: callerDeviceIdWithProof,
          recipientUserId: calleeUserIdWithProof,
          callType: "audio",
          signedAt,
          sdpHash,
        }),
        callerSigner.privateKey
      )
    );

    try {
      callerWs.send(
        JSON.stringify({
          type: "call.offer",
          callId,
          targetUserId: calleeUserIdWithProof,
          callType: "audio",
          sdp: offerSdp,
          auth: {
            version: 1,
            senderUserId: callerUserIdWithProof,
            senderDeviceId: callerDeviceIdWithProof,
            recipientUserId: calleeUserIdWithProof,
            signedAt,
            sdpHash,
            signature,
          },
        })
      );

      await waitForWsMessage(
        calleeWs,
        (msg) => msg.type === "call.offer" && msg.callId === callId
      );

      const hangupResponse = await apiRequest(
        `/calls/${callId}/direct-hangup`,
        {
          method: "POST",
        },
        callerTokenWithProof
      );
      expect(hangupResponse.status).toBe(200);
      expect((hangupResponse.body as { ok?: boolean }).ok).toBe(true);

      const hangup = await waitForWsMessage(
        calleeWs,
        (msg) => msg.type === "call.hangup" && msg.callId === callId
      );
      expect(hangup.type).toBe("call.hangup");
      await waitFor(async () => {
        const persisted = await loadPersistedCallSession(callId);
        return persisted?.status === "missed" && persisted.ended_at !== null;
      });
    } finally {
      callerWs.close();
      calleeWs.close();
    }
  });

  it("terminates a direct-call routing session through the direct-reject endpoint", async () => {
    const sodium = await ensureSodium();
    const callerSigner = sodium.crypto_sign_keypair();
    const caller = await registerUser(`drj_c_${Date.now().toString(36)}`, {
      signingKeyPublic: toBase64Url(callerSigner.publicKey),
    });
    expect(caller.status).toBe(201);
    const callerToken = (caller.body as { accessToken: string }).accessToken;
    const callerUserId = (caller.body as { userId: string }).userId;
    const callerDeviceId = (caller.body as { deviceId: string }).deviceId;

    const callee = await registerUser(`drj_d_${Date.now().toString(36)}`);
    expect(callee.status).toBe(201);
    const calleeToken = (callee.body as { accessToken: string }).accessToken;
    const calleeUserId = (callee.body as { userId: string }).userId;

    const createCallResponse = await apiRequest(
      "/calls",
      {
        method: "POST",
        body: JSON.stringify({
          calleeUserId,
          callType: "audio",
        }),
      },
      callerToken
    );
    expect(createCallResponse.status).toBe(200);
    const callId = (createCallResponse.body as { callId: string }).callId;

    const callerWs = await openAuthedWebSocket(callerToken);
    const calleeWs = await openAuthedWebSocket(calleeToken);
    const offerSdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
    const signedAt = new Date().toISOString();
    const sdpHash = hashCallSdp(offerSdp);
    const signature = toBase64Url(
      sodium.crypto_sign_detached(
        buildOfferCallAuthMaterial({
          callId,
          senderUserId: callerUserId,
          senderDeviceId: callerDeviceId,
          recipientUserId: calleeUserId,
          callType: "audio",
          signedAt,
          sdpHash,
        }),
        callerSigner.privateKey
      )
    );

    try {
      callerWs.send(
        JSON.stringify({
          type: "call.offer",
          callId,
          targetUserId: calleeUserId,
          callType: "audio",
          sdp: offerSdp,
          auth: {
            version: 1,
            senderUserId: callerUserId,
            senderDeviceId: callerDeviceId,
            recipientUserId: calleeUserId,
            signedAt,
            sdpHash,
            signature,
          },
        })
      );

      await waitForWsMessage(
        calleeWs,
        (msg) => msg.type === "call.offer" && msg.callId === callId
      );

      const rejectResponse = await apiRequest(
        `/calls/${callId}/direct-reject`,
        {
          method: "POST",
        },
        calleeToken
      );
      expect(rejectResponse.status).toBe(200);
      expect((rejectResponse.body as { ok?: boolean }).ok).toBe(true);

      const rejected = await waitForWsMessage(
        callerWs,
        (msg) => msg.type === "call.rejected" && msg.callId === callId
      );
      expect(rejected.type).toBe("call.rejected");
      await waitFor(async () => {
        const persisted = await loadPersistedCallSession(callId);
        return (
          persisted?.status === "rejected" &&
          persisted.ended_at !== null
        );
      });
    } finally {
      callerWs.close();
      calleeWs.close();
    }
  });

  it("allows group call access for active members and rejects outsiders", async () => {
    const memberAccess = await apiRequest(
      `/calls/${groupCallId}/sfu-access`,
      {},
      groupMemberToken
    );
    expect(memberAccess.status).toBe(200);
    expect((memberAccess.body as { ok?: boolean }).ok).toBe(true);

    const outsiderAccess = await apiRequest(
      `/calls/${groupCallId}/sfu-access`,
      {},
      groupOutsiderToken
    );
    expect(outsiderAccess.status).toBe(403);
    expect((outsiderAccess.body as { error?: string }).error).toBe("Forbidden");
  });

  it("returns the active group call contract to group members only", async () => {
    const memberView = await apiRequest(
      `/groups/${groupId}/active-call`,
      {},
      groupMemberToken
    );
    expect(memberView.status).toBe(200);

    const parsed = GroupActiveCallSchema.safeParse(memberView.body);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.callId).toBe(groupCallId);
    expect(parsed.data?.callType).toBe("video");
    expect(parsed.data?.status).toBe("ringing");

    const outsiderView = await apiRequest(
      `/groups/${groupId}/active-call`,
      {},
      groupOutsiderToken
    );
    expect(outsiderView.status).toBe(403);
    expect((outsiderView.body as { error?: string }).error).toBe(
      "Not a group member"
    );
  });

  it("rejects group call creation for non-members", async () => {
    const forbiddenCreate = await apiRequest(
      "/calls",
      {
        method: "POST",
        body: JSON.stringify({
          groupId,
          callType: "audio",
        }),
      },
      groupOutsiderToken
    );
    expect(forbiddenCreate.status).toBe(403);
    expect((forbiddenCreate.body as { error?: string }).error).toBe(
      "Not a group member"
    );
  });
});

describe("Group call lifecycle events", () => {
  let ownerToken = "";
  let ownerUserId = "";
  let ownerDeviceId = "";
  let memberToken = "";
  let memberUsername = "";
  let memberUserId = "";
  let memberDeviceId = "";
  let groupId = "";

  beforeAll(async () => {
    const owner = await registerUser(`gcle_owner_${Date.now()}`);
    expect(owner.status).toBe(201);
    ownerToken = (owner.body as { accessToken: string }).accessToken;
    ownerUserId = (owner.body as { userId: string }).userId;
    ownerDeviceId = (owner.body as { deviceId: string }).deviceId;

    memberUsername = `gcle_member_${Date.now()}`;
    const member = await registerUser(memberUsername);
    expect(member.status).toBe(201);
    memberToken = (member.body as { accessToken: string }).accessToken;
    memberUserId = (member.body as { userId: string }).userId;
    memberDeviceId = (member.body as { deviceId: string }).deviceId;

    const createdGroup = await apiRequest(
      "/groups",
      {
        method: "POST",
        body: JSON.stringify({
          name: `Lifecycle Group ${Date.now()}`,
          memberUserIds: [memberUserId],
        }),
      },
      ownerToken
    );
    expect(createdGroup.status).toBe(201);
    groupId = (createdGroup.body as { groupId: string }).groupId;
  });

  it("broadcasts group call lifecycle and maintains participant roster", async () => {
    const ownerWs = await openAuthedWebSocket(ownerToken);
    const memberWs = await openAuthedWebSocket(memberToken);

    try {
      const created = await apiRequest(
        "/calls",
        {
          method: "POST",
          body: JSON.stringify({
            groupId,
            callType: "audio",
          }),
        },
        ownerToken
      );
      expect(created.status).toBe(200);
      const createdBody = created.body as { callId: string; created?: boolean };
      const callId = createdBody.callId;
      expect(createdBody.created).toBe(true);
      expect((created.body as { callerUserId?: string }).callerUserId).toBe(ownerUserId);

      const startedEvent = await waitForWsMessage(
        memberWs,
        (msg) => msg.type === "group.call.started" && msg.callId === callId
      );
      expect(startedEvent.type).toBe("group.call.started");

      const reused = await apiRequest(
        "/calls",
        {
          method: "POST",
          body: JSON.stringify({
            groupId,
            callType: "video",
          }),
        },
        memberToken
      );
      expect(reused.status).toBe(200);
      const reusedBody = reused.body as { callId: string; created?: boolean };
      expect(reusedBody.callId).toBe(callId);
      expect(reusedBody.created).toBe(false);
      expect((reused.body as { callerUserId?: string }).callerUserId).toBe(ownerUserId);

      const joinedEvent = await waitForWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.participant_joined" &&
          msg.callId === callId &&
          msg.userId === memberUserId
      );
      expect(joinedEvent.type).toBe("group.call.participant_joined");

      const roster = await apiRequest(
        `/calls/${callId}/participants`,
        {},
        ownerToken
      );
      expect(roster.status).toBe(200);
      const parsedRoster = GroupCallParticipantsResponseSchema.safeParse(
        roster.body
      );
      expect(parsedRoster.success).toBe(true);
      expect(parsedRoster.data?.version).toBe(GROUPS_PROTOCOL_VERSION);
      const participants = parsedRoster.data?.participants ?? [];
      expect(participants).toHaveLength(2);

      const leave = await apiRequest(
        `/calls/${callId}/participants/me`,
        {
          method: "DELETE",
        },
        memberToken
      );
      expect(leave.status).toBe(200);

      const leftEvent = await waitForWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.participant_left" &&
          msg.callId === callId &&
          msg.userId === memberUserId
      );
      expect(leftEvent.type).toBe("group.call.participant_left");

      const joinAgain = await apiRequest(
        `/calls/${callId}/participants`,
        {
          method: "POST",
        },
        memberToken
      );
      expect(joinAgain.status).toBe(200);
      expect(
        (joinAgain.body as { participants: Array<{ userId: string }> })
          .participants
      ).toHaveLength(2);

      const forbiddenEnd = await apiRequest(
        `/calls/${callId}/status`,
        {
          method: "PUT",
          body: JSON.stringify({ status: "ended" }),
        },
        memberToken
      );
      expect(forbiddenEnd.status).toBe(403);

      const ended = await apiRequest(
        `/calls/${callId}/status`,
        {
          method: "PUT",
          body: JSON.stringify({ status: "ended" }),
        },
        ownerToken
      );
      expect(ended.status).toBe(200);

      const endedEvent = await waitForWsMessage(
        ownerWs,
        (msg) => msg.type === "group.call.ended" && msg.callId === callId
      );
      expect(endedEvent.type).toBe("group.call.ended");

      const activeCallAfterEnd = await apiRequest(
        `/groups/${groupId}/active-call`,
        {},
        ownerToken
      );
      expect(activeCallAfterEnd.status).toBe(404);
      expect((activeCallAfterEnd.body as { error?: string }).error).toBe(
        "No active call"
      );
    } finally {
      ownerWs.close();
      memberWs.close();
    }
  });

  it("auto-ends a group room when the last active participant leaves", async () => {
    const memberWs = await openAuthedWebSocket(memberToken);

    try {
      const created = await apiRequest(
        "/calls",
        {
          method: "POST",
          body: JSON.stringify({
            groupId,
            callType: "audio",
          }),
        },
        ownerToken
      );
      expect(created.status).toBe(200);
      const callId = (created.body as { callId: string }).callId;

      const ownerLeave = await apiRequest(
        `/calls/${callId}/participants/me`,
        {
          method: "DELETE",
        },
        ownerToken
      );
      expect(ownerLeave.status).toBe(200);

      const endedEvent = await waitForWsMessage(
        memberWs,
        (msg) => msg.type === "group.call.ended" && msg.callId === callId
      );
      expect(endedEvent.type).toBe("group.call.ended");

      const activeAfterLeave = await apiRequest(
        `/groups/${groupId}/active-call`,
        {},
        ownerToken
      );
      expect(activeAfterLeave.status).toBe(404);
    } finally {
      memberWs.close();
    }
  });

  it("treats room.join and room.leave as transport-only signals and keeps roster ownership on HTTP membership routes", async () => {
    const ownerWs = await openAuthedWebSocket(ownerToken);
    const memberWs = await openAuthedWebSocket(memberToken);

    try {
      const created = await apiRequest(
        "/calls",
        {
          method: "POST",
          body: JSON.stringify({
            groupId,
            callType: "video",
          }),
        },
        ownerToken
      );
      expect(created.status).toBe(200);
      const callId = (created.body as { callId: string }).callId;

      const join = await apiRequest(
        `/calls/${callId}/participants`,
        {
          method: "POST",
        },
        memberToken
      );
      expect(join.status).toBe(200);

      const joinedEvent = await waitForWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.participant_joined" &&
          msg.callId === callId &&
          msg.userId === memberUserId
      );
      expect(joinedEvent.type).toBe("group.call.participant_joined");
      if (joinedEvent.type === "group.call.participant_joined") {
        expect(joinedEvent.deviceId).toBe(memberDeviceId);
      }

      const deviceJoinedEvent = await waitForWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.participant_device_joined" &&
          msg.callId === callId &&
          msg.userId === memberUserId &&
          msg.deviceId === memberDeviceId
      );
      expect(deviceJoinedEvent.type).toBe(
        "group.call.participant_device_joined"
      );

      const rosterAfterHttpJoin = await apiRequest(
        `/calls/${callId}/participants`,
        {},
        ownerToken
      );
      expect(rosterAfterHttpJoin.status).toBe(200);
      expect(
        (
          rosterAfterHttpJoin.body as {
            participants: Array<{ userId: string }>;
          }
        ).participants
      ).toHaveLength(2);

      memberWs.send(
        JSON.stringify({
          type: "room.join",
          roomId: callId,
          rtpCapabilities: JSON.stringify({ codecs: [] }),
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(
        takeQueuedWsMessage(
          ownerWs,
          (msg) =>
            (msg.type === "group.call.participant_joined" ||
              msg.type === "group.call.participant_device_joined") &&
            msg.callId === callId &&
            msg.userId === memberUserId
        )
      ).toBeNull();

      const rosterAfterRoomJoin = await apiRequest(
        `/calls/${callId}/participants`,
        {},
        ownerToken
      );
      expect(rosterAfterRoomJoin.status).toBe(200);
      expect(
        (
          rosterAfterRoomJoin.body as {
            participants: Array<{ userId: string }>;
          }
        ).participants
      ).toHaveLength(2);

      memberWs.send(
        JSON.stringify({
          type: "room.leave",
          roomId: callId,
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(
        takeQueuedWsMessage(
          ownerWs,
          (msg) =>
            (msg.type === "group.call.participant_left" ||
              msg.type === "group.call.participant_device_left") &&
            msg.callId === callId &&
            msg.userId === memberUserId
        )
      ).toBeNull();

      const rosterAfterLeave = await apiRequest(
        `/calls/${callId}/participants`,
        {},
        ownerToken
      );
      expect(rosterAfterLeave.status).toBe(200);
      expect(
        (rosterAfterLeave.body as { participants: Array<{ userId: string }> })
          .participants
      ).toHaveLength(2);

      const httpLeave = await apiRequest(
        `/calls/${callId}/participants/me`,
        {
          method: "DELETE",
        },
        memberToken
      );
      expect(httpLeave.status).toBe(200);

      const leftEvent = await waitForWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.participant_left" &&
          msg.callId === callId &&
          msg.userId === memberUserId
      );
      expect(leftEvent.type).toBe("group.call.participant_left");
      if (leftEvent.type === "group.call.participant_left") {
        expect(leftEvent.deviceId).toBe(memberDeviceId);
      }

      const deviceLeftEvent = await waitForWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.participant_device_left" &&
          msg.callId === callId &&
          msg.userId === memberUserId &&
          msg.deviceId === memberDeviceId
      );
      expect(deviceLeftEvent.type).toBe("group.call.participant_device_left");

      const rosterAfterHttpLeave = await apiRequest(
        `/calls/${callId}/participants`,
        {},
        ownerToken
      );
      expect(rosterAfterHttpLeave.status).toBe(200);
      expect(
        (
          rosterAfterHttpLeave.body as {
            participants: Array<{ userId: string }>;
          }
        ).participants
      ).toHaveLength(1);

      const end = await apiRequest(
        `/calls/${callId}/status`,
        {
          method: "PUT",
          body: JSON.stringify({ status: "ended" }),
        },
        ownerToken
      );
      expect(end.status).toBe(200);
    } finally {
      ownerWs.close();
      memberWs.close();
    }
  });

  it("removes group-call roster membership on websocket disconnect after transport attach", async () => {
    const ownerWs = await openAuthedWebSocket(ownerToken);
    const memberWs = await openAuthedWebSocket(memberToken);

    try {
      const created = await apiRequest(
        "/calls",
        {
          method: "POST",
          body: JSON.stringify({
            groupId,
            callType: "audio",
          }),
        },
        ownerToken
      );
      expect(created.status).toBe(200);
      const callId = (created.body as { callId: string }).callId;

      const join = await apiRequest(
        `/calls/${callId}/participants`,
        {
          method: "POST",
        },
        memberToken
      );
      expect(join.status).toBe(200);

      await waitForWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.participant_joined" &&
          msg.callId === callId &&
          msg.userId === memberUserId
      );
      await waitForWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.participant_device_joined" &&
          msg.callId === callId &&
          msg.userId === memberUserId &&
          msg.deviceId === memberDeviceId
      );

      memberWs.send(
        JSON.stringify({
          type: "room.join",
          roomId: callId,
          rtpCapabilities: JSON.stringify({ codecs: [] }),
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 150));
      memberWs.close();

      const deviceLeftEvent = await waitForWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.participant_device_left" &&
          msg.callId === callId &&
          msg.userId === memberUserId &&
          msg.deviceId === memberDeviceId
      );
      expect(deviceLeftEvent.type).toBe("group.call.participant_device_left");

      const leftEvent = await waitForWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.participant_left" &&
          msg.callId === callId &&
          msg.userId === memberUserId &&
          msg.deviceId === memberDeviceId
      );
      expect(leftEvent.type).toBe("group.call.participant_left");

      const rosterAfterDisconnect = await apiRequest(
        `/calls/${callId}/participants`,
        {},
        ownerToken
      );
      expect(rosterAfterDisconnect.status).toBe(200);
      expect(
        (
          rosterAfterDisconnect.body as {
            participants: Array<{ userId: string }>;
          }
        ).participants
      ).toHaveLength(1);

      const end = await apiRequest(
        `/calls/${callId}/status`,
        {
          method: "PUT",
          body: JSON.stringify({ status: "ended" }),
        },
        ownerToken
      );
      expect(end.status).toBe(200);
    } finally {
      ownerWs.close();
      memberWs.close();
    }
  });

  it("returns authoritative per-device roster for active group-call participants", async () => {
    const created = await apiRequest(
      "/calls",
      {
        method: "POST",
        body: JSON.stringify({
          groupId,
          callType: "audio",
        }),
      },
      ownerToken
    );
    expect(created.status).toBe(200);
    const callId = (created.body as { callId: string }).callId;

    const join = await apiRequest(
      `/calls/${callId}/participants`,
      {
        method: "POST",
      },
      memberToken
    );
    expect(join.status).toBe(200);

    const rosterAfterJoin = await apiRequest(
      `/calls/${callId}/participant-devices`,
      {},
      ownerToken
    );
    expect(rosterAfterJoin.status).toBe(200);
    const parsedDevicesAfterJoin =
      GroupCallParticipantDevicesResponseSchema.safeParse(rosterAfterJoin.body);
    expect(parsedDevicesAfterJoin.success).toBe(true);
    expect(parsedDevicesAfterJoin.data?.version).toBe(GROUPS_PROTOCOL_VERSION);
    const participantDevicesAfterJoin =
      parsedDevicesAfterJoin.data?.participantDevices ?? [];
    expect(participantDevicesAfterJoin).toEqual(
      expect.arrayContaining([
        { userId: memberUserId, deviceId: memberDeviceId },
        { userId: ownerUserId, deviceId: ownerDeviceId },
      ])
    );

    const leave = await apiRequest(
      `/calls/${callId}/participants/me`,
      {
        method: "DELETE",
      },
      memberToken
    );
    expect(leave.status).toBe(200);

    const rosterAfterLeave = await apiRequest(
      `/calls/${callId}/participant-devices`,
      {},
      ownerToken
    );
    expect(rosterAfterLeave.status).toBe(200);
    const parsedDevicesAfterLeave =
      GroupCallParticipantDevicesResponseSchema.safeParse(rosterAfterLeave.body);
    expect(parsedDevicesAfterLeave.success).toBe(true);
    expect(parsedDevicesAfterLeave.data?.version).toBe(
      GROUPS_PROTOCOL_VERSION
    );
    const participantDevicesAfterLeave =
      parsedDevicesAfterLeave.data?.participantDevices ?? [];
    expect(participantDevicesAfterLeave).not.toEqual(
      expect.arrayContaining([
        { userId: memberUserId, deviceId: memberDeviceId },
      ])
    );

    const end = await apiRequest(
      `/calls/${callId}/status`,
      {
        method: "PUT",
        body: JSON.stringify({ status: "ended" }),
      },
      ownerToken
    );
    expect(end.status).toBe(200);
  });

  it("pushes producer lifecycle state to active participant devices", async () => {
    const ownerWs = await openAuthedWebSocket(ownerToken);
    const memberWs = await openAuthedWebSocket(memberToken);

    try {
      const created = await apiRequest(
        "/calls",
        {
          method: "POST",
          body: JSON.stringify({
            groupId,
            callType: "video",
          }),
        },
        ownerToken
      );
      expect(created.status).toBe(200);
      const callId = (created.body as { callId: string }).callId;

      const join = await apiRequest(
        `/calls/${callId}/participants`,
        {
          method: "POST",
        },
        memberToken
      );
      expect(join.status).toBe(200);

      memberWs.send(
        JSON.stringify({
          type: "group.call.producer_state",
          callId,
          producerId: "producer-audio-1",
          kind: "video",
          source: "screen",
          state: "added",
        })
      );

      const addedEvent = await waitForWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.producer_state" &&
          msg.callId === callId &&
          msg.userId === memberUserId &&
          msg.deviceId === memberDeviceId &&
          msg.producerId === "producer-audio-1" &&
          msg.kind === "video" &&
          msg.source === "screen" &&
          msg.state === "added"
      );
      expect(addedEvent.type).toBe("group.call.producer_state");

      memberWs.send(
        JSON.stringify({
          type: "group.call.producer_state",
          callId,
          producerId: "producer-audio-1",
          kind: "video",
          source: "screen",
          state: "removed",
        })
      );

      const removedEvent = await waitForWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.producer_state" &&
          msg.callId === callId &&
          msg.userId === memberUserId &&
          msg.deviceId === memberDeviceId &&
          msg.producerId === "producer-audio-1" &&
          msg.kind === "video" &&
          msg.source === "screen" &&
          msg.state === "removed"
      );
      expect(removedEvent.type).toBe("group.call.producer_state");

      await new Promise((resolve) => setTimeout(resolve, 200));
      const leakedSelfEvent = takeQueuedWsMessage(
        memberWs,
        (msg) =>
          msg.type === "group.call.producer_state" && msg.callId === callId
      );
      expect(leakedSelfEvent).toBeNull();

      const end = await apiRequest(
        `/calls/${callId}/status`,
        {
          method: "PUT",
          body: JSON.stringify({ status: "ended" }),
        },
        ownerToken
      );
      expect(end.status).toBe(200);
    } finally {
      ownerWs.close();
      memberWs.close();
    }
  });

  it("routes group call media keys only to active participant devices", async () => {
    const ownerWs = await openAuthedWebSocket(ownerToken);
    const memberWs = await openAuthedWebSocket(memberToken);

    try {
      const created = await apiRequest(
        "/calls",
        {
          method: "POST",
          body: JSON.stringify({
            groupId,
            callType: "audio",
          }),
        },
        ownerToken
      );
      expect(created.status).toBe(200);
      const callId = (created.body as { callId: string }).callId;

      const join = await apiRequest(
        `/calls/${callId}/participants`,
        {
          method: "POST",
        },
        memberToken
      );
      expect(join.status).toBe(200);

      ownerWs.send(
        JSON.stringify({
          type: "group.call.media-key",
          callId,
          targetDeviceId: memberDeviceId,
          epoch: 1,
          keyId: "sender-key-1",
          algorithm: "aes-256-gcm",
          encryptedKey: "v1.ciphertext",
        })
      );

      const mediaKeyEvent = await waitForWsMessage(
        memberWs,
        (msg) =>
          msg.type === "group.call.media-key" &&
          msg.callId === callId &&
          msg.targetDeviceId === memberDeviceId
      );

      expect(mediaKeyEvent.type).toBe("group.call.media-key");
      if (mediaKeyEvent.type === "group.call.media-key") {
        expect(mediaKeyEvent.senderUserId).not.toBe(memberUserId);
        expect(mediaKeyEvent.senderDeviceId).toBeTypeOf("string");
        expect(mediaKeyEvent.algorithm).toBe("aes-256-gcm");
        expect(mediaKeyEvent.epoch).toBe(1);
        expect(mediaKeyEvent.keyId).toBe("sender-key-1");
        expect(mediaKeyEvent.encryptedKey).toBe("v1.ciphertext");
      }

      const end = await apiRequest(
        `/calls/${callId}/status`,
        {
          method: "PUT",
          body: JSON.stringify({ status: "ended" }),
        },
        ownerToken
      );
      expect(end.status).toBe(200);
    } finally {
      ownerWs.close();
      memberWs.close();
    }
  });

  it("routes group call media-key acknowledgements back to sender device", async () => {
    const ownerWs = await openAuthedWebSocket(ownerToken);
    const memberWs = await openAuthedWebSocket(memberToken);

    try {
      const created = await apiRequest(
        "/calls",
        {
          method: "POST",
          body: JSON.stringify({
            groupId,
            callType: "audio",
          }),
        },
        ownerToken
      );
      expect(created.status).toBe(200);
      const callId = (created.body as { callId: string }).callId;

      const join = await apiRequest(
        `/calls/${callId}/participants`,
        {
          method: "POST",
        },
        memberToken
      );
      expect(join.status).toBe(200);

      ownerWs.send(
        JSON.stringify({
          type: "group.call.media-key",
          callId,
          targetDeviceId: memberDeviceId,
          epoch: 1,
          keyId: "sender-key-ack-1",
          algorithm: "aes-256-gcm",
          encryptedKey: "v1.ciphertext",
        })
      );

      await waitForWsMessage(
        memberWs,
        (msg) =>
          msg.type === "group.call.media-key" &&
          msg.callId === callId &&
          msg.targetDeviceId === memberDeviceId &&
          msg.keyId === "sender-key-ack-1"
      );

      memberWs.send(
        JSON.stringify({
          type: "group.call.media-key.ack",
          callId,
          targetDeviceId: ownerDeviceId,
          epoch: 1,
          keyId: "sender-key-ack-1",
        })
      );

      const ackEvent = await waitForWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.media-key.ack" &&
          msg.callId === callId &&
          msg.targetDeviceId === ownerDeviceId &&
          msg.senderDeviceId === memberDeviceId &&
          msg.keyId === "sender-key-ack-1"
      );
      expect(ackEvent.type).toBe("group.call.media-key.ack");
      if (ackEvent.type === "group.call.media-key.ack") {
        expect(ackEvent.epoch).toBe(1);
      }

      const end = await apiRequest(
        `/calls/${callId}/status`,
        {
          method: "PUT",
          body: JSON.stringify({ status: "ended" }),
        },
        ownerToken
      );
      expect(end.status).toBe(200);
    } finally {
      ownerWs.close();
      memberWs.close();
    }
  });

  it("rejects group call media keys for same-user sibling devices that did not join", async () => {
    const fakeKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const fakeSig =
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const siblingLogin = await apiRequest("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        version: AUTH_PROTOCOL_VERSION,
        username: memberUsername,
        password: "TestPassword123!",
        device: {
          name: "Sibling Group Call Device",
          identityKeyPublic: fakeKey,
          signingKeyPublic: fakeKey,
          registrationId: 7777,
          signedPreKey: { id: 1, publicKey: fakeKey, signature: fakeSig },
          oneTimePreKeys: [{ id: 1, publicKey: fakeKey }],
        },
      }),
    });
    expect(siblingLogin.status).toBe(200);
    const siblingToken = (siblingLogin.body as { accessToken: string })
      .accessToken;
    const siblingDeviceId = (siblingLogin.body as { deviceId: string })
      .deviceId;

    const ownerWs = await openAuthedWebSocket(ownerToken);
    const siblingWs = await openAuthedWebSocket(siblingToken);

    try {
      const created = await apiRequest(
        "/calls",
        {
          method: "POST",
          body: JSON.stringify({
            groupId,
            callType: "audio",
          }),
        },
        ownerToken
      );
      expect(created.status).toBe(200);
      const callId = (created.body as { callId: string }).callId;

      const join = await apiRequest(
        `/calls/${callId}/participants`,
        {
          method: "POST",
        },
        memberToken
      );
      expect(join.status).toBe(200);

      ownerWs.send(
        JSON.stringify({
          type: "group.call.media-key",
          callId,
          targetDeviceId: siblingDeviceId,
          epoch: 1,
          keyId: "sender-key-reject",
          algorithm: "aes-256-gcm",
          encryptedKey: "v1.ciphertext.reject",
        })
      );

      const rejection = await waitForWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "error" && msg.code === "TARGET_DEVICE_NOT_ALLOWED"
      );
      expect(rejection.type).toBe("error");

      await new Promise((resolve) => setTimeout(resolve, 200));
      const leakedMessage = takeQueuedWsMessage(
        siblingWs,
        (msg) => msg.type === "group.call.media-key" && msg.callId === callId
      );
      expect(leakedMessage).toBeNull();

      const end = await apiRequest(
        `/calls/${callId}/status`,
        {
          method: "PUT",
          body: JSON.stringify({ status: "ended" }),
        },
        ownerToken
      );
      expect(end.status).toBe(200);
    } finally {
      ownerWs.close();
      siblingWs.close();
    }
  });

  it("rejects group call media keys sent from same-user sibling devices that did not join", async () => {
    const fakeKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const fakeSig =
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const siblingLogin = await apiRequest("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        version: AUTH_PROTOCOL_VERSION,
        username: memberUsername,
        password: "TestPassword123!",
        device: {
          name: "Sibling Sender Group Call Device",
          identityKeyPublic: fakeKey,
          signingKeyPublic: fakeKey,
          registrationId: 8888,
          signedPreKey: { id: 1, publicKey: fakeKey, signature: fakeSig },
          oneTimePreKeys: [{ id: 1, publicKey: fakeKey }],
        },
      }),
    });
    expect(siblingLogin.status).toBe(200);
    const siblingToken = (siblingLogin.body as { accessToken: string })
      .accessToken;

    const ownerWs = await openAuthedWebSocket(ownerToken);
    const siblingWs = await openAuthedWebSocket(siblingToken);

    try {
      const created = await apiRequest(
        "/calls",
        {
          method: "POST",
          body: JSON.stringify({
            groupId,
            callType: "audio",
          }),
        },
        ownerToken
      );
      expect(created.status).toBe(200);
      const callId = (created.body as { callId: string }).callId;

      siblingWs.send(
        JSON.stringify({
          type: "group.call.media-key",
          callId,
          targetDeviceId: ownerDeviceId,
          epoch: 1,
          keyId: "sender-key-forbidden",
          algorithm: "aes-256-gcm",
          encryptedKey: "v1.ciphertext.forbidden",
        })
      );

      const rejection = await waitForWsMessage(
        siblingWs,
        (msg) => msg.type === "error" && msg.code === "FORBIDDEN"
      );
      expect(rejection.type).toBe("error");

      await new Promise((resolve) => setTimeout(resolve, 200));
      const leakedMessage = takeQueuedWsMessage(
        ownerWs,
        (msg) => msg.type === "group.call.media-key" && msg.callId === callId
      );
      expect(leakedMessage).toBeNull();

      const end = await apiRequest(
        `/calls/${callId}/status`,
        {
          method: "PUT",
          body: JSON.stringify({ status: "ended" }),
        },
        ownerToken
      );
      expect(end.status).toBe(200);
    } finally {
      ownerWs.close();
      siblingWs.close();
    }
  });

  it("blocks group.call signals immediately after active member revocation", async () => {
    const revoked = await registerUser(`gcle_revoked_${Date.now()}`);
    expect(revoked.status).toBe(201);
    const revokedToken = (revoked.body as { accessToken: string }).accessToken;
    const revokedUserId = (revoked.body as { userId: string }).userId;
    const revokedDeviceId = (revoked.body as { deviceId: string }).deviceId;

    const addMember = await apiRequest(
      `/groups/${groupId}/members`,
      {
        method: "POST",
        body: JSON.stringify({
          userIds: [revokedUserId],
        }),
      },
      ownerToken
    );
    expect(addMember.status).toBe(200);

    const ownerWs = await openAuthedWebSocket(ownerToken);
    const revokedWs = await openAuthedWebSocket(revokedToken);

    try {
      const created = await apiRequest(
        "/calls",
        {
          method: "POST",
          body: JSON.stringify({
            groupId,
            callType: "audio",
          }),
        },
        ownerToken
      );
      expect(created.status).toBe(200);
      const callId = (created.body as { callId: string }).callId;

      const join = await apiRequest(
        `/calls/${callId}/participants`,
        {
          method: "POST",
        },
        revokedToken
      );
      expect(join.status).toBe(200);

      const removeMember = await apiRequest(
        `/groups/${groupId}/members/${revokedUserId}`,
        {
          method: "DELETE",
        },
        ownerToken
      );
      expect(removeMember.status).toBe(200);

      revokedWs.send(
        JSON.stringify({
          type: "group.call.producer_state",
          callId,
          producerId: "revoked-producer",
          kind: "audio",
          state: "added",
        })
      );

      const producerStateRejection = await waitForWsMessage(
        revokedWs,
        (msg) => msg.type === "error" && msg.code === "FORBIDDEN"
      );
      expect(producerStateRejection.type).toBe("error");

      revokedWs.send(
        JSON.stringify({
          type: "group.call.media-key",
          callId,
          targetDeviceId: ownerDeviceId,
          epoch: 1,
          keyId: "revoked-sender-key",
          algorithm: "aes-256-gcm",
          encryptedKey: "v1.ciphertext.revoked",
        })
      );

      const mediaKeyRejection = await waitForWsMessage(
        revokedWs,
        (msg) => msg.type === "error" && msg.code === "FORBIDDEN"
      );
      expect(mediaKeyRejection.type).toBe("error");

      await new Promise((resolve) => setTimeout(resolve, 200));
      const leakedProducerState = takeQueuedWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.producer_state" &&
          msg.callId === callId &&
          msg.userId === revokedUserId &&
          msg.deviceId === revokedDeviceId
      );
      const leakedMediaKey = takeQueuedWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.media-key" &&
          msg.callId === callId &&
          msg.senderUserId === revokedUserId &&
          msg.senderDeviceId === revokedDeviceId
      );
      expect(leakedProducerState).toBeNull();
      expect(leakedMediaKey).toBeNull();

      const end = await apiRequest(
        `/calls/${callId}/status`,
        {
          method: "PUT",
          body: JSON.stringify({ status: "ended" }),
        },
        ownerToken
      );
      expect(end.status).toBe(200);
    } finally {
      ownerWs.close();
      revokedWs.close();
    }
  });

  it("emits device-scoped participant lifecycle for sibling devices without collapsing user-level roster", async () => {
    const fakeKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const fakeSig =
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const siblingLogin = await apiRequest("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        version: AUTH_PROTOCOL_VERSION,
        username: memberUsername,
        password: "TestPassword123!",
        device: {
          name: "Sibling Lifecycle Device",
          identityKeyPublic: fakeKey,
          signingKeyPublic: fakeKey,
          registrationId: 9998,
          signedPreKey: { id: 1, publicKey: fakeKey, signature: fakeSig },
          oneTimePreKeys: [{ id: 1, publicKey: fakeKey }],
        },
      }),
    });
    expect(siblingLogin.status).toBe(200);
    const siblingToken = (siblingLogin.body as { accessToken: string })
      .accessToken;
    const siblingDeviceId = (siblingLogin.body as { deviceId: string })
      .deviceId;

    const ownerWs = await openAuthedWebSocket(ownerToken);

    try {
      const created = await apiRequest(
        "/calls",
        {
          method: "POST",
          body: JSON.stringify({
            groupId,
            callType: "audio",
          }),
        },
        ownerToken
      );
      expect(created.status).toBe(200);
      const callId = (created.body as { callId: string }).callId;

      const memberJoin = await apiRequest(
        `/calls/${callId}/participants`,
        {
          method: "POST",
        },
        memberToken
      );
      expect(memberJoin.status).toBe(200);

      const firstJoinUserEvent = await waitForWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.participant_joined" &&
          msg.callId === callId &&
          msg.userId === memberUserId &&
          msg.deviceId === memberDeviceId
      );
      expect(firstJoinUserEvent.type).toBe("group.call.participant_joined");

      const firstJoinDeviceEvent = await waitForWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.participant_device_joined" &&
          msg.callId === callId &&
          msg.userId === memberUserId &&
          msg.deviceId === memberDeviceId
      );
      expect(firstJoinDeviceEvent.type).toBe(
        "group.call.participant_device_joined"
      );

      const siblingJoin = await apiRequest(
        `/calls/${callId}/participants`,
        {
          method: "POST",
        },
        siblingToken
      );
      expect(siblingJoin.status).toBe(200);

      const siblingJoinDeviceEvent = await waitForWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.participant_device_joined" &&
          msg.callId === callId &&
          msg.userId === memberUserId &&
          msg.deviceId === siblingDeviceId
      );
      expect(siblingJoinDeviceEvent.type).toBe(
        "group.call.participant_device_joined"
      );

      await new Promise((resolve) => setTimeout(resolve, 200));
      const duplicateUserJoin = takeQueuedWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.participant_joined" &&
          msg.callId === callId &&
          msg.userId === memberUserId
      );
      expect(duplicateUserJoin).toBeNull();

      const siblingLeave = await apiRequest(
        `/calls/${callId}/participants/me`,
        {
          method: "DELETE",
        },
        siblingToken
      );
      expect(siblingLeave.status).toBe(200);

      const siblingLeftDeviceEvent = await waitForWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.participant_device_left" &&
          msg.callId === callId &&
          msg.userId === memberUserId &&
          msg.deviceId === siblingDeviceId
      );
      expect(siblingLeftDeviceEvent.type).toBe(
        "group.call.participant_device_left"
      );

      await new Promise((resolve) => setTimeout(resolve, 200));
      const prematureUserLeft = takeQueuedWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.participant_left" &&
          msg.callId === callId &&
          msg.userId === memberUserId
      );
      expect(prematureUserLeft).toBeNull();

      const rosterWhilePrimaryDeviceStillJoined = await apiRequest(
        `/calls/${callId}/participants`,
        {},
        ownerToken
      );
      expect(rosterWhilePrimaryDeviceStillJoined.status).toBe(200);
      expect(
        (
          rosterWhilePrimaryDeviceStillJoined.body as {
            participants: Array<{ userId: string }>;
          }
        ).participants
      ).toHaveLength(2);

      const memberLeave = await apiRequest(
        `/calls/${callId}/participants/me`,
        {
          method: "DELETE",
        },
        memberToken
      );
      expect(memberLeave.status).toBe(200);

      const finalDeviceLeft = await waitForWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.participant_device_left" &&
          msg.callId === callId &&
          msg.userId === memberUserId &&
          msg.deviceId === memberDeviceId
      );
      expect(finalDeviceLeft.type).toBe("group.call.participant_device_left");

      const finalUserLeft = await waitForWsMessage(
        ownerWs,
        (msg) =>
          msg.type === "group.call.participant_left" &&
          msg.callId === callId &&
          msg.userId === memberUserId &&
          msg.deviceId === memberDeviceId
      );
      expect(finalUserLeft.type).toBe("group.call.participant_left");

      const end = await apiRequest(
        `/calls/${callId}/status`,
        {
          method: "PUT",
          body: JSON.stringify({ status: "ended" }),
        },
        ownerToken
      );
      expect(end.status).toBe(200);
    } finally {
      ownerWs.close();
    }
  });

  it("deduplicates concurrent group call creation and preserves a single roster", async () => {
    const [ownerCreate, memberCreate] = await Promise.all([
      apiRequest(
        "/calls",
        {
          method: "POST",
          body: JSON.stringify({
            groupId,
            callType: "audio",
          }),
        },
        ownerToken
      ),
      apiRequest(
        "/calls",
        {
          method: "POST",
          body: JSON.stringify({
            groupId,
            callType: "video",
          }),
        },
        memberToken
      ),
    ]);

    expect(ownerCreate.status).toBe(200);
    expect(memberCreate.status).toBe(200);

    const callId = (ownerCreate.body as { callId: string }).callId;
    expect((memberCreate.body as { callId: string }).callId).toBe(callId);

    // The advisory lock makes the winner of the race the call host; only the
    // host may end a group call, so pick the token that matches callerUserId.
    const hostUserId = (ownerCreate.body as { callerUserId: string }).callerUserId;
    expect((memberCreate.body as { callerUserId: string }).callerUserId).toBe(hostUserId);
    const hostToken = hostUserId === ownerUserId ? ownerToken : memberToken;

    const roster = await apiRequest(
      `/calls/${callId}/participants`,
      {},
      ownerToken
    );
    expect(roster.status).toBe(200);
    const participants = (
      roster.body as {
        participants: Array<{ userId: string; username: string }>;
      }
    ).participants;
    expect(participants).toHaveLength(2);
    expect(
      participants.some((participant) => participant.userId === memberUserId)
    ).toBe(true);

    const end = await apiRequest(
      `/calls/${callId}/status`,
      {
        method: "PUT",
        body: JSON.stringify({ status: "ended" }),
      },
      hostToken
    );
    expect(end.status).toBe(200);

    const activeAfterEnd = await apiRequest(
      `/groups/${groupId}/active-call`,
      {},
      ownerToken
    );
    expect(activeAfterEnd.status).toBe(404);
  });
});

describe("User search", () => {
  const username = `searchable_${Date.now()}`;
  let token = "";

  beforeAll(async () => {
    await registerUser(username);
    const { body } = await registerUser(`searcher_${Date.now()}`);
    token = (body as { accessToken: string }).accessToken;
  });

  it("finds a user by partial username", async () => {
    const prefix = username;
    const { status, body } = await apiRequest(
      `/users/search?q=${encodeURIComponent(prefix)}`,
      {},
      token
    );
    expect(status).toBe(200);
    const typed = body as { users: Array<{ username: string }> };
    const found = typed.users.some((u) => u.username === username);
    expect(found).toBe(true);
  });

  it("returns empty for short query", async () => {
    const { status, body } = await apiRequest("/users/search?q=a", {}, token);
    expect(status).toBe(200);
    const typed = body as { users: unknown[] };
    expect(typed.users).toEqual([]);
  });
});

describe("Presence metadata", () => {
  let targetUserId = "";
  let observerToken = "";

  beforeAll(async () => {
    const target = await registerUser(`presence_target_${Date.now()}`);
    expect(target.status).toBe(201);
    targetUserId = (target.body as { userId: string }).userId;

    const observer = await registerUser(`presence_observer_${Date.now()}`);
    expect(observer.status).toBe(201);
    observerToken = (observer.body as { accessToken: string }).accessToken;
  });

  it("requires an explicit relationship before exposing presence metadata", async () => {
    const blocked = await apiRequest(
      `/users/${targetUserId}/presence`,
      {},
      observerToken
    );
    expect(blocked.status).toBe(403);
    expect((blocked.body as { error?: string }).error).toBe(
      "Relationship required"
    );

    const relationship = await createDirectRelationship(
      observerToken,
      targetUserId
    );
    expect(relationship.status).toBe(200);

    const { status, body } = await apiRequest(
      `/users/${targetUserId}/presence`,
      {},
      observerToken
    );
    expect(status).toBe(200);
    const typed = body as {
      userId?: string;
      online?: boolean;
      lastSeenAt?: string;
    };
    expect(typed.userId).toBe(targetUserId);
    expect(typeof typed.online).toBe("boolean");
    if (typed.lastSeenAt !== undefined) {
      expect(Number.isNaN(new Date(typed.lastSeenAt).getTime())).toBe(false);
    }
  });
});

describe("Group chat contracts", () => {
  let ownerToken = "";
  let memberToken = "";
  let newMemberToken = "";
  let outsiderToken = "";
  let ownerUserId = "";
  let memberUserId = "";
  let newMemberUserId = "";
  let newMemberDeviceId = "";
  let lateJoinUserId = "";
  let groupId = "";

  beforeAll(async () => {
    const owner = await registerUser(`group_owner_${Date.now()}`);
    expect(owner.status).toBe(201);
    ownerToken = (owner.body as { accessToken: string }).accessToken;
    ownerUserId = (owner.body as { userId: string }).userId;

    const member = await registerUser(`group_member_${Date.now()}`);
    expect(member.status).toBe(201);
    memberToken = (member.body as { accessToken: string }).accessToken;
    memberUserId = (member.body as { userId: string }).userId;

    const newMember = await registerUser(`group_new_member_${Date.now()}`);
    expect(newMember.status).toBe(201);
    newMemberToken = (newMember.body as { accessToken: string }).accessToken;
    newMemberUserId = (newMember.body as { userId: string }).userId;
    newMemberDeviceId = (newMember.body as { deviceId: string }).deviceId;

    const lateJoin = await registerUser(`group_late_join_${Date.now()}`);
    expect(lateJoin.status).toBe(201);
    lateJoinUserId = (lateJoin.body as { userId: string }).userId;

    const outsider = await registerUser(`group_outsider_${Date.now()}`);
    expect(outsider.status).toBe(201);
    outsiderToken = (outsider.body as { accessToken: string }).accessToken;
  });

  it("creates a group with creator + invited members and returns it to member", async () => {
    const created = await apiRequest(
      "/groups",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Test Group",
          memberUserIds: [memberUserId],
        }),
      },
      ownerToken
    );

    expect(created.status).toBe(201);
    const createdBody = created.body as {
      groupId: string;
      cryptoEpoch: number;
      members: Array<{ userId: string }>;
    };
    groupId = createdBody.groupId;
    expect(typeof groupId).toBe("string");
    expect(createdBody.cryptoEpoch).toBe(1);
    expect(
      createdBody.members.some((member) => member.userId === ownerUserId)
    ).toBe(true);
    expect(
      createdBody.members.some((member) => member.userId === memberUserId)
    ).toBe(true);

    const memberView = await apiRequest(`/groups/${groupId}`, {}, memberToken);
    expect(memberView.status).toBe(200);
    expect((memberView.body as { groupId: string }).groupId).toBe(groupId);
  });

  it("rejects unknown user IDs on group create", async () => {
    const unknownUserId = crypto.randomUUID();
    const created = await apiRequest(
      "/groups",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Invalid Group",
          memberUserIds: [unknownUserId],
        }),
      },
      ownerToken
    );

    expect(created.status).toBe(404);
    const body = created.body as { error?: string; missingUserIds?: string[] };
    expect(body.error).toBe("Users not found");
    expect(body.missingUserIds).toContain(unknownUserId);
  });

  it("adds valid members and rejects unknown user IDs", async () => {
    const unknownUserId = crypto.randomUUID();

    const invalidAdd = await apiRequest(
      `/groups/${groupId}/members`,
      {
        method: "POST",
        body: JSON.stringify({
          userIds: [unknownUserId],
        }),
      },
      ownerToken
    );

    expect(invalidAdd.status).toBe(404);
    const invalidBody = invalidAdd.body as {
      error?: string;
      missingUserIds?: string[];
    };
    expect(invalidBody.error).toBe("Users not found");
    expect(invalidBody.missingUserIds).toContain(unknownUserId);

    const validAdd = await apiRequest(
      `/groups/${groupId}/members`,
      {
        method: "POST",
        body: JSON.stringify({
          userIds: [newMemberUserId],
        }),
      },
      ownerToken
    );
    expect(validAdd.status).toBe(200);
    const validAddBody = validAdd.body as { ok?: boolean; cryptoEpoch?: number };
    expect(validAddBody.ok).toBe(true);
    expect(validAddBody.cryptoEpoch).toBeGreaterThan(1);

    const groupAfterAdd = await apiRequest(
      `/groups/${groupId}`,
      {},
      ownerToken
    );
    expect(groupAfterAdd.status).toBe(200);
    expect(
      (groupAfterAdd.body as { cryptoEpoch?: number }).cryptoEpoch
    ).toBe(validAddBody.cryptoEpoch);
    expect(
      (
        groupAfterAdd.body as { members: Array<{ userId: string }> }
      ).members.some((member) => member.userId === newMemberUserId)
    ).toBe(true);
  });

  it("forbids regular member from adding users until promoted", async () => {
    const addByRegularMember = await apiRequest(
      `/groups/${groupId}/members`,
      {
        method: "POST",
        body: JSON.stringify({
          userIds: [lateJoinUserId],
        }),
      },
      newMemberToken
    );

    expect(addByRegularMember.status).toBe(403);
    expect((addByRegularMember.body as { error?: string }).error).toBe(
      "Insufficient group permissions"
    );
  });

  it("allows owner to promote member to admin and admin to add users", async () => {
    const promote = await apiRequest(
      `/groups/${groupId}/members/${memberUserId}/role`,
      {
        method: "PUT",
        body: JSON.stringify({
          role: "admin",
        }),
      },
      ownerToken
    );
    expect(promote.status).toBe(200);
    expect((promote.body as { ok?: boolean }).ok).toBe(true);

    const addByAdmin = await apiRequest(
      `/groups/${groupId}/members`,
      {
        method: "POST",
        body: JSON.stringify({
          userIds: [lateJoinUserId],
        }),
      },
      memberToken
    );
    expect(addByAdmin.status).toBe(200);
    expect((addByAdmin.body as { ok?: boolean }).ok).toBe(true);
  });

  it("allows admin to remove regular members and forbids outsider access", async () => {
    const outsiderView = await apiRequest(
      `/groups/${groupId}`,
      {},
      outsiderToken
    );
    expect(outsiderView.status).toBe(403);
    expect((outsiderView.body as { error?: string }).error).toBe(
      "Not a group member"
    );

    const removeByRegularMember = await apiRequest(
      `/groups/${groupId}/members/${lateJoinUserId}`,
      {
        method: "DELETE",
      },
      newMemberToken
    );
    expect(removeByRegularMember.status).toBe(403);
    expect((removeByRegularMember.body as { error?: string }).error).toBe(
      "Insufficient group permissions"
    );

    const removeByAdmin = await apiRequest(
      `/groups/${groupId}/members/${newMemberUserId}`,
      {
        method: "DELETE",
      },
      memberToken
    );
    expect(removeByAdmin.status).toBe(200);
    const removeByAdminBody = removeByAdmin.body as {
      ok?: boolean;
      cryptoEpoch?: number;
    };
    expect(removeByAdminBody.ok).toBe(true);
    expect(removeByAdminBody.cryptoEpoch).toBeGreaterThan(1);

    const groupAfterRemove = await apiRequest(
      `/groups/${groupId}`,
      {},
      ownerToken
    );
    expect(groupAfterRemove.status).toBe(200);
    expect(
      (groupAfterRemove.body as { cryptoEpoch?: number }).cryptoEpoch
    ).toBe(removeByAdminBody.cryptoEpoch);

    const memberDevicesAfterRemove = await apiRequest(
      `/groups/${groupId}/member-devices`,
      {},
      ownerToken
    );
    expect(memberDevicesAfterRemove.status).toBe(200);
    expect(
      (
        memberDevicesAfterRemove.body as {
          members: Array<{
            userId: string;
            devices: Array<{ deviceId: string }>;
          }>;
        }
      ).members.some(
        (member) =>
          member.userId === newMemberUserId ||
          member.devices.some((device) => device.deviceId === newMemberDeviceId)
      )
    ).toBe(false);

    const removedMemberSend = await apiRequest(
      `/groups/${groupId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          clientMessageId: crypto.randomUUID(),
          groupId,
          distributionId: crypto.randomUUID(),
          cryptoEpoch: 1,
          chainId: 0,
          messageId: 1,
          ciphertext: "AAAA",
          signature: "BBBB",
          type: "text",
        }),
      },
      newMemberToken
    );
    expect(removedMemberSend.status).toBe(403);
    expect((removedMemberSend.body as { error?: string }).error).toBe(
      "Not a group member"
    );

    const removedMemberView = await apiRequest(
      `/groups/${groupId}`,
      {},
      newMemberToken
    );
    expect(removedMemberView.status).toBe(403);
    expect((removedMemberView.body as { error?: string }).error).toBe(
      "Not a group member"
    );
  });
});

describe("Messaging contracts", () => {
  let senderToken = "";
  let senderUserId = "";
  let recipientToken = "";
  let recipientUsername = "";
  let recipientUserId = "";
  let recipientDeviceId = "";
  const oversizedCiphertext = "A".repeat(13 * 1024 * 1024);

  beforeAll(async () => {
    const sender = await registerUser(`msg_sender_${Date.now()}`);
    expect(sender.status).toBe(201);
    senderToken = (sender.body as { accessToken: string }).accessToken;
    senderUserId = (sender.body as { userId: string }).userId;

    recipientUsername = `msg_recipient_${Date.now()}`;
    const recipient = await registerUser(recipientUsername, {
      registrationId: 7001,
    });
    expect(recipient.status).toBe(201);
    recipientToken = (recipient.body as { accessToken: string }).accessToken;
    recipientUserId = (recipient.body as { userId: string }).userId;
    recipientDeviceId = (recipient.body as { deviceId: string }).deviceId;
  });

  it("returns 404 when all recipient devices are invalid", async () => {
    const { status, body } = await apiRequest(
      "/messages",
      {
        method: "POST",
        body: JSON.stringify({
          clientMessageId: crypto.randomUUID(),
          recipientUserId,
          messages: [
            {
              recipientDeviceId: crypto.randomUUID(),
              ciphertext: "AAAA",
              type: "text",
            },
          ],
        }),
      },
      senderToken
    );

    expect(status).toBe(404);
    expect((body as { error?: string }).error).toBe(
      "No valid recipient devices"
    );
  });

  it("rejects oversized direct-message payloads with 413", async () => {
    const { status } = await apiRequest(
      "/messages",
      {
        method: "POST",
        body: JSON.stringify({
          clientMessageId: crypto.randomUUID(),
          recipientUserId,
          messages: [
            {
              recipientDeviceId: crypto.randomUUID(),
              ciphertext: oversizedCiphertext,
              type: "text",
            },
          ],
        }),
      },
      senderToken
    );

    expect(status).toBe(413);
  });

  it("forwards typing only after a direct relationship exists", async () => {
    const senderWs = await openAuthedWebSocket(senderToken);
    const recipientWs = await openAuthedWebSocket(recipientToken);

    try {
      senderWs.send(
        JSON.stringify({
          type: "typing.start",
          targetUserId: recipientUserId,
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 200));
      const leakedTypingBeforeRelationship = takeQueuedWsMessage(
        recipientWs,
        (msg) =>
          msg.type === "typing.start" && msg.senderUserId === senderUserId
      );
      expect(leakedTypingBeforeRelationship).toBeNull();

      const send = await apiRequest(
        "/messages",
        {
          method: "POST",
          body: JSON.stringify({
            clientMessageId: crypto.randomUUID(),
            recipientUserId,
            messages: [
              {
                recipientDeviceId,
                ciphertext: "AAAA",
                type: "text",
              },
            ],
          }),
        },
        senderToken
      );
      expect(send.status).toBe(202);

      await waitForWsMessage(
        recipientWs,
        (msg) =>
          msg.type === "message.new" &&
          msg.message.senderUserId === senderUserId
      );

      senderWs.send(
        JSON.stringify({
          type: "typing.start",
          targetUserId: recipientUserId,
        })
      );

      const typingAfterRelationship = await waitForWsMessage(
        recipientWs,
        (msg) =>
          msg.type === "typing.start" && msg.senderUserId === senderUserId
      );
      expect(typingAfterRelationship.type).toBe("typing.start");
    } finally {
      senderWs.close();
      recipientWs.close();
    }
  });

  it("accepts idempotent resend for the same direct payload", async () => {
    const payload = {
      clientMessageId: crypto.randomUUID(),
      recipientUserId,
      messages: [
        {
          recipientDeviceId,
          ciphertext: "AAAA",
          type: "text" as const,
        },
      ],
    };

    const firstSend = await apiRequest(
      "/messages",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      senderToken
    );
    expect(firstSend.status).toBe(202);

    const secondSend = await apiRequest(
      "/messages",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      senderToken
    );
    expect(secondSend.status).toBe(202);

    expect((secondSend.body as { messageId?: string }).messageId).toBe(
      (firstSend.body as { messageId?: string }).messageId
    );
  });

  it("returns per-device delivery details for direct sends", async () => {
    const siblingKey = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const fakeSig =
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const siblingLogin = await apiRequest("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        version: AUTH_PROTOCOL_VERSION,
        username: recipientUsername,
        password: "TestPassword123!",
        device: {
          name: "Recipient Sibling",
          identityKeyPublic: siblingKey,
          signingKeyPublic: siblingKey,
          registrationId: 8123,
          signedPreKey: { id: 11, publicKey: siblingKey, signature: fakeSig },
          oneTimePreKeys: [{ id: 21, publicKey: siblingKey }],
        },
      }),
    });
    expect(siblingLogin.status).toBe(200);
    const siblingDeviceId = (siblingLogin.body as { deviceId: string })
      .deviceId;

    const payload = {
      clientMessageId: crypto.randomUUID(),
      recipientUserId,
      messages: [
        {
          recipientDeviceId,
          ciphertext: "AAAA",
          type: "text" as const,
        },
        {
          recipientDeviceId: siblingDeviceId,
          ciphertext: "BBBB",
          type: "text" as const,
        },
      ],
    };

    const firstSend = await apiRequest(
      "/messages",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      senderToken
    );
    expect(firstSend.status).toBe(202);
    const firstBody = firstSend.body as {
      messageId: string;
      deliveries: Array<{
        recipientDeviceId: string;
        messageId: string;
        status: string;
      }>;
    };
    expect(firstBody.deliveries).toHaveLength(2);
    expect(firstBody.messageId).toBe(firstBody.deliveries[0]?.messageId);
    expect(firstBody.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipientDeviceId,
          status: "created",
        }),
        expect.objectContaining({
          recipientDeviceId: siblingDeviceId,
          status: "created",
        }),
      ])
    );

    const duplicateSend = await apiRequest(
      "/messages",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      senderToken
    );
    expect(duplicateSend.status).toBe(202);
    const duplicateBody = duplicateSend.body as typeof firstBody;
    expect(duplicateBody.deliveries).toEqual(
      firstBody.deliveries.map((delivery) => ({
        ...delivery,
        status: "duplicate",
      }))
    );
  });
});

describe("Push preferences and delivery controls", () => {
  let senderToken = "";
  let recipientToken = "";
  let recipientUserId = "";
  let recipientDeviceId = "";

  beforeAll(async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS push_preferences (
        user_id                  UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        direct_messages_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
        group_messages_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
        call_invites_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
        show_sender              BOOLEAN NOT NULL DEFAULT TRUE,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const sender = await registerUser(`push_sender_${Date.now()}`);
    expect(sender.status).toBe(201);
    senderToken = (sender.body as { accessToken: string }).accessToken;

    const recipient = await registerUser(`push_recipient_${Date.now()}`);
    expect(recipient.status).toBe(201);
    recipientToken = (recipient.body as { accessToken: string }).accessToken;
    recipientUserId = (recipient.body as { userId: string }).userId;
    recipientDeviceId = (recipient.body as { deviceId: string }).deviceId;
  });

  it("returns default push preferences for a new user", async () => {
    const { status, body } = await apiRequest(
      "/push/preferences",
      {},
      recipientToken
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      directMessagesEnabled: true,
      groupMessagesEnabled: true,
      callInvitesEnabled: true,
      showSender: true,
    });
  });

  it("updates push preferences for the authenticated user", async () => {
    const { status, body } = await apiRequest(
      "/push/preferences",
      {
        method: "PUT",
        body: JSON.stringify({
          directMessagesEnabled: false,
          groupMessagesEnabled: true,
          callInvitesEnabled: true,
          showSender: false,
        }),
      },
      recipientToken
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      directMessagesEnabled: false,
      groupMessagesEnabled: true,
      callInvitesEnabled: true,
      showSender: false,
    });
  });

  it("lists active push subscriptions for the authenticated user and revokes by id", async () => {
    const inserted = await query<{ id: string }>(
      `INSERT INTO push_subscriptions (
         user_id,
         device_id,
         endpoint,
         p256dh,
         auth,
         user_agent,
         last_success_at,
         revoked_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, now(), NULL, now())
       RETURNING id`,
      [
        recipientUserId,
        recipientDeviceId,
        `https://push.example/${crypto.randomUUID()}`,
        "p256dh",
        "auth",
        "Test Browser",
      ]
    );
    const subscriptionId = inserted[0]!.id;

    const list = await apiRequest("/push/subscriptions", {}, recipientToken);
    expect(list.status).toBe(200);
    const subscriptions = (
      list.body as {
        subscriptions: Array<{
          id: string;
          userAgent: string | null;
          currentDevice: boolean;
          lastSuccessAt: string | null;
        }>;
      }
    ).subscriptions;
    expect(
      subscriptions.some(
        (subscription) =>
          subscription.id === subscriptionId &&
          subscription.userAgent === "Test Browser" &&
          subscription.currentDevice === true &&
          typeof subscription.lastSuccessAt === "string"
      )
    ).toBe(true);

    const revoke = await apiRequest(
      `/push/subscriptions/${subscriptionId}`,
      { method: "DELETE" },
      recipientToken
    );
    expect(revoke.status).toBe(204);

    const afterRevoke = await apiRequest(
      "/push/subscriptions",
      {},
      recipientToken
    );
    expect(afterRevoke.status).toBe(200);
    expect(
      (
        afterRevoke.body as { subscriptions: Array<{ id: string }> }
      ).subscriptions.some((subscription) => subscription.id === subscriptionId)
    ).toBe(false);
  });
});

describe("Group history contract", () => {
  let ownerToken = "";
  let memberToken = "";
  let groupId = "";
  const oversizedCiphertext = "B".repeat(13 * 1024 * 1024);

  beforeAll(async () => {
    const owner = await registerUser(`gh_owner_${Date.now()}`);
    expect(owner.status).toBe(201);
    ownerToken = (owner.body as { accessToken: string }).accessToken;

    const member = await registerUser(`gh_member_${Date.now()}`);
    expect(member.status).toBe(201);
    memberToken = (member.body as { accessToken: string }).accessToken;
    const memberUserId = (member.body as { userId: string }).userId;

    const createdGroup = await apiRequest(
      "/groups",
      {
        method: "POST",
        body: JSON.stringify({
          name: "History Contract",
          memberUserIds: [memberUserId],
        }),
      },
      ownerToken
    );
    expect(createdGroup.status).toBe(201);
    groupId = (createdGroup.body as { groupId: string }).groupId;
  });

  it("returns canonical camelCase DTO for group history", async () => {
    const send = await apiRequest(
      `/groups/${groupId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          clientMessageId: crypto.randomUUID(),
          groupId,
          distributionId: crypto.randomUUID(),
          chainId: 0,
          messageId: 1,
          ciphertext: "AAAA",
          signature: "BBBB",
          type: "text",
        }),
      },
      ownerToken
    );
    expect(send.status).toBe(202);

    const history = await apiRequest(
      `/groups/${groupId}/messages?limit=10`,
      {},
      memberToken
    );
    expect(history.status).toBe(200);

    const parsed = GroupHistoryResponseSchema.safeParse(history.body);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.messages.length).toBeGreaterThan(0);
    expect((history.body as { version?: number }).version).toBe(GROUPS_PROTOCOL_VERSION);

    const first = parsed.data!.messages[0]!;
    expect(typeof first.senderDeviceId).toBe("string");
    expect(typeof first.distributionId).toBe("string");
    expect(first.cryptoEpoch).toBe(1);
    expect(first.messageType).toBe("text");
    expect(
      (history.body as { messages: Array<Record<string, unknown>> })
        .messages[0]?.["sender_device_id"]
    ).toBeUndefined();
    expect(
      (history.body as { messages: Array<Record<string, unknown>> })
        .messages[0]?.["created_at"]
    ).toBeUndefined();
  });

  it("rejects group messages encrypted for a future crypto epoch", async () => {
    const send = await apiRequest(
      `/groups/${groupId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          clientMessageId: crypto.randomUUID(),
          groupId,
          distributionId: crypto.randomUUID(),
          cryptoEpoch: 2,
          chainId: 0,
          messageId: 1,
          ciphertext: "AAAA",
          signature: "BBBB",
          type: "text",
        }),
      },
      ownerToken
    );

    expect(send.status).toBe(409);
    expect((send.body as { error?: string }).error).toBe(
      "Group crypto epoch mismatch"
    );
  });

  it("does not duplicate group realtime fan-out on idempotent resend", async () => {
    const memberWs = await openAuthedWebSocket(memberToken);
    const distributionId = crypto.randomUUID();
    const chainId = 0;
    const messageId = Math.floor(Math.random() * 1_000_000) + 10;

    try {
      const payload = {
        clientMessageId: crypto.randomUUID(),
        groupId,
        distributionId,
        chainId,
        messageId,
        ciphertext: "AAAA",
        signature: "BBBB",
        type: "text" as const,
      };

      const firstSend = await apiRequest(
        `/groups/${groupId}/messages`,
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
        ownerToken
      );
      expect(firstSend.status).toBe(202);

      const duplicateSend = await apiRequest(
        `/groups/${groupId}/messages`,
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
        ownerToken
      );
      expect(duplicateSend.status).toBe(202);

      const firstEvent = await waitForWsMessage(
        memberWs,
        (msg) =>
          msg.type === "group_message.new" &&
          msg.groupId === groupId &&
          msg.distributionId === distributionId &&
          msg.chainId === chainId &&
          msg.messageId === messageId
      );
      expect(firstEvent.type).toBe("group_message.new");

      await new Promise((resolve) => setTimeout(resolve, 200));
      const duplicatedEvent = takeQueuedWsMessage(
        memberWs,
        (msg) =>
          msg.type === "group_message.new" &&
          msg.groupId === groupId &&
          msg.distributionId === distributionId &&
          msg.chainId === chainId &&
          msg.messageId === messageId
      );
      expect(duplicatedEvent).toBeNull();
    } finally {
      memberWs.close();
    }
  });

  it("rejects oversized group-message payloads with 413", async () => {
    const send = await apiRequest(
      `/groups/${groupId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          clientMessageId: crypto.randomUUID(),
          groupId,
          distributionId: crypto.randomUUID(),
          chainId: 0,
          messageId: 1,
          ciphertext: oversizedCiphertext,
          signature: "BBBB",
          type: "text",
        }),
      },
      ownerToken
    );
    expect(send.status).toBe(413);
  });
});

describe("Message ACK reliability", () => {
  let senderToken = "";
  let recipientToken = "";
  let recipientUserId = "";
  let recipientDeviceId = "";

  beforeAll(async () => {
    const sender = await registerUser(`ack_sender_${Date.now()}`);
    expect(sender.status).toBe(201);
    senderToken = (sender.body as { accessToken: string }).accessToken;

    const recipient = await registerUser(`ack_recipient_${Date.now()}`);
    expect(recipient.status).toBe(201);
    recipientToken = (recipient.body as { accessToken: string }).accessToken;
    recipientUserId = (recipient.body as { userId: string }).userId;
    recipientDeviceId = (recipient.body as { deviceId: string }).deviceId;
  });

  async function sendMessageToRecipient(): Promise<string> {
    const send = await apiRequest(
      "/messages",
      {
        method: "POST",
        body: JSON.stringify({
          clientMessageId: crypto.randomUUID(),
          recipientUserId,
          messages: [
            {
              recipientDeviceId,
              ciphertext: "AAAA",
              type: "text",
            },
          ],
        }),
      },
      senderToken
    );

    expect(send.status).toBe(202);
    const messageId = (send.body as { messageId: string }).messageId;
    expect(typeof messageId).toBe("string");
    return messageId;
  }

  it("returns 200 on first ack, 409 on repeated ack, 404 for non-recipient ack", async () => {
    const messageId = await sendMessageToRecipient();

    const firstAck = await apiRequest(
      `/messages/${messageId}/ack`,
      { method: "POST" },
      recipientToken
    );
    expect(firstAck.status).toBe(200);
    expect((firstAck.body as { ok?: boolean }).ok).toBe(true);

    const secondAck = await apiRequest(
      `/messages/${messageId}/ack`,
      { method: "POST" },
      recipientToken
    );
    expect(secondAck.status).toBe(409);
    expect((secondAck.body as { error?: string }).error).toBe(
      "Message already acknowledged"
    );

    const wrongRecipientAck = await apiRequest(
      `/messages/${messageId}/ack`,
      { method: "POST" },
      senderToken
    );
    expect(wrongRecipientAck.status).toBe(404);
    expect((wrongRecipientAck.body as { error?: string }).error).toBe(
      "Message not found"
    );
  });

  it("persists WS ack so pending queue no longer returns the message", async () => {
    const messageId = await sendMessageToRecipient();
    const pendingBefore = await apiRequest(
      "/messages/pending",
      {},
      recipientToken
    );
    expect(pendingBefore.status).toBe(200);
    expect(
      (pendingBefore.body as { messages: Array<{ id: string }> }).messages.some(
        (message) => message.id === messageId
      )
    ).toBe(true);

    const ws = await openAuthedWebSocket(recipientToken);
    try {
      ws.send(JSON.stringify({ type: "ack", messageId }));

      await waitFor(async () => {
        const pendingAfter = await apiRequest(
          "/messages/pending",
          {},
          recipientToken
        );
        if (pendingAfter.status !== 200) return false;
        return !(
          pendingAfter.body as { messages: Array<{ id: string }> }
        ).messages.some((message) => message.id === messageId);
      });
    } finally {
      ws.close();
    }
  });
});
