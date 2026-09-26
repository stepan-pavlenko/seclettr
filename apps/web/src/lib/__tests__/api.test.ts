import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEVICES_PROTOCOL_VERSION,
  GROUPS_PROTOCOL_VERSION,
} from "@seclettr/protocol";
import { api, ApiError, setAccessToken, type PushPreferencesDto, type PushSubscriptionDto } from "@/lib/api";

describe("api", () => {
  beforeEach(() => {
    setAccessToken(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setAccessToken(null);
  });

  it("returns undefined for a successful empty body without relying on Content-Length", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.get<void>("/health")).resolves.toBeUndefined();
  });

  it("parses json when the response body is present", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.get<{ ok: boolean }>("/health")).resolves.toEqual({ ok: true });
  });

  it("uses plain-text error bodies when json parsing is not available", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("Gateway timeout", {
        status: 504,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.get("/health")).rejects.toEqual(new ApiError(504, "Gateway timeout"));
  });

  it("stops after a single refresh attempt when refresh itself returns 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
          },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "No refresh token" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
          },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.get("/health")).rejects.toEqual(new ApiError(401, "Session expired"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/health");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/auth/refresh");
  });

  it("returns null for missing active group call lookups", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "No active call" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getActiveGroupCall("11111111-1111-4111-8111-111111111111")).resolves.toBeNull();
  });

  it("parses canonical versioned active group call payloads", async () => {
    const payload = {
      version: GROUPS_PROTOCOL_VERSION,
      callId: "11111111-1111-4111-8111-111111111111",
      callType: "audio",
      status: "ringing",
      callerUserId: "22222222-2222-4222-8222-222222222222",
      createdAt: "2026-03-26T00:00:00.000Z",
      answeredAt: null,
    } as const;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getActiveGroupCall("group-1")).resolves.toEqual({
      callId: payload.callId,
      callType: payload.callType,
      status: payload.status,
      callerUserId: payload.callerUserId,
      createdAt: payload.createdAt,
      answeredAt: payload.answeredAt,
    });
  });

  it("returns typed participant roster for group-call membership helpers", async () => {
    const participants = [
      {
        userId: "11111111-1111-4111-8111-111111111111",
        username: "alice",
      },
      {
        userId: "22222222-2222-4222-8222-222222222222",
        username: "bob",
      },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          version: GROUPS_PROTOCOL_VERSION,
          participants,
        }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          version: GROUPS_PROTOCOL_VERSION,
          ok: true,
          participants,
        }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getGroupCallParticipants("call-1")).resolves.toEqual(participants);
    await expect(api.joinGroupCall("call-1")).resolves.toEqual(participants);
  });

  it("returns typed per-device participant roster for group calls", async () => {
    const participantDevices = [
      {
        userId: "11111111-1111-4111-8111-111111111111",
        deviceId: "aaaaaaaa-1111-4111-8111-111111111111",
      },
      {
        userId: "22222222-2222-4222-8222-222222222222",
        deviceId: "bbbbbbbb-2222-4222-8222-222222222222",
      },
    ];

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        version: GROUPS_PROTOCOL_VERSION,
        participantDevices,
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getGroupCallParticipantDevices("call-1")).resolves.toEqual(participantDevices);
  });

  it("parses canonical versioned user-device directory payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        version: DEVICES_PROTOCOL_VERSION,
        devices: [
          {
            deviceId: "11111111-1111-4111-8111-111111111111",
            identityKeyPublic: "identity-key",
            signingKeyPublic: "signing-key",
          },
        ],
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.getUserDeviceDirectory("22222222-2222-4222-8222-222222222222")
    ).resolves.toEqual([
      {
        deviceId: "11111111-1111-4111-8111-111111111111",
        identityKeyPublic: "identity-key",
        signingKeyPublic: "signing-key",
      },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/users/22222222-2222-4222-8222-222222222222/devices"
    );
  });

  it("rejects malformed user-device directory payloads instead of accepting ad-hoc shapes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        devices: [
          {
            device_id: "11111111-1111-4111-8111-111111111111",
            identity_key_public: "identity-key",
          },
        ],
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.getUserDeviceDirectory("22222222-2222-4222-8222-222222222222")
    ).rejects.toThrow("Invalid API payload");
  });

  it("rejects malformed group-call participant roster payloads instead of accepting unversioned shapes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        participants: [
          {
            user_id: "11111111-1111-4111-8111-111111111111",
            username: "alice",
          },
        ],
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getGroupCallParticipants("call-1")).rejects.toThrow(
      "Invalid API payload"
    );
  });

  it("parses canonical versioned group member device payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        version: GROUPS_PROTOCOL_VERSION,
        members: [
          {
            userId: "11111111-1111-4111-8111-111111111111",
            devices: [
              {
                deviceId: "22222222-2222-4222-8222-222222222222",
                identityKeyPublic: "identity-key",
                signingKeyPublic: "signing-key",
              },
            ],
          },
        ],
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getGroupMemberDevices("group-1")).resolves.toEqual([
      {
        userId: "11111111-1111-4111-8111-111111111111",
        devices: [
          {
            deviceId: "22222222-2222-4222-8222-222222222222",
            identityKeyPublic: "identity-key",
            signingKeyPublic: "signing-key",
          },
        ],
      },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/groups/group-1/member-devices");
  });

  it("rejects legacy or malformed group member device payloads instead of falling back to per-user enumeration", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        members: [
          {
            user_id: "11111111-1111-4111-8111-111111111111",
            devices: [
              {
                device_id: "22222222-2222-4222-8222-222222222222",
                identity_key_public: "identity-key",
                signing_key_public: "signing-key",
              },
            ],
          },
        ],
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getGroupMemberDevices("group-1")).rejects.toThrow(
      "Invalid API payload"
    );
  });

  it("parses canonical versioned group history payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        version: GROUPS_PROTOCOL_VERSION,
        messages: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            senderDeviceId: "22222222-2222-4222-8222-222222222222",
            distributionId: "33333333-3333-4333-8333-333333333333",
            chainId: 0,
            messageId: 1,
            messageType: "text",
            ciphertext: "AAAA",
            signature: "BBBB",
            createdAt: "2026-03-26T00:00:00.000Z",
            aeadVersion: 1,
          },
        ],
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getGroupHistory("group-1", { limit: 10 })).resolves.toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        senderDeviceId: "22222222-2222-4222-8222-222222222222",
        distributionId: "33333333-3333-4333-8333-333333333333",
        chainId: 0,
        messageId: 1,
        messageType: "text",
        ciphertext: "AAAA",
        signature: "BBBB",
        createdAt: "2026-03-26T00:00:00.000Z",
        aeadVersion: 1,
        cryptoEpoch: 1,
      },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/groups/group-1/messages?limit=10");
  });

  it("rejects legacy snake_case group history payloads instead of normalizing them client-side", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        version: GROUPS_PROTOCOL_VERSION,
        messages: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            sender_device_id: "22222222-2222-4222-8222-222222222222",
            distribution_id: "33333333-3333-4333-8333-333333333333",
            chain_id: 0,
            message_id: 1,
            message_type: "text",
            ciphertext: "AAAA",
            signature: "BBBB",
            created_at: "2026-03-26T00:00:00.000Z",
          },
        ],
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getGroupHistory("group-1")).rejects.toThrow("Invalid API payload");
  });

  it("treats leaveGroupCall as an empty success response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.leaveGroupCall("call-1")).resolves.toBeUndefined();
  });

  it("treats directHangupCall and directRejectCall as empty success responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.directHangupCall("call-1")).resolves.toBeUndefined();
    await expect(api.directRejectCall("call-2")).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/calls/call-1/direct-hangup");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/calls/call-2/direct-reject");
  });

  it("sends versioned current-device crypto material sync payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.syncCurrentDeviceCryptoMaterial({
        identityKeyPublic: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        signingKeyPublic: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        signedPreKey: {
          id: 7,
          publicKey: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
          signature:
            "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
        },
      })
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/devices/crypto-material",
      expect.objectContaining({
        method: "PUT",
        credentials: "include",
        headers: expect.any(Headers),
      })
    );
    const requestOptions = fetchMock.mock.calls[0]?.[1] as { body: string };
    expect(JSON.parse(requestOptions.body)).toEqual({
      version: 1,
      identityKeyPublic: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      signingKeyPublic: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      signedPreKey: {
        id: 7,
        publicKey: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        signature:
          "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
      },
    });
  });

  it("sends keepalive leave request with bearer auth when available", async () => {
    setAccessToken("token-1");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    api.leaveGroupCallKeepalive("call-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/calls/call-1/participants/me",
      expect.objectContaining({
        method: "DELETE",
        credentials: "include",
        keepalive: true,
        headers: expect.any(Headers),
      })
    );
    const requestOptions = fetchMock.mock.calls[0]?.[1] as { headers: Headers };
    expect(requestOptions.headers.get("Authorization")).toBe("Bearer token-1");
  });

  it("sends keepalive direct hangup request with bearer auth when available", async () => {
    setAccessToken("token-1");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    api.directHangupCallKeepalive("call-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/calls/call-1/direct-hangup",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        keepalive: true,
        headers: expect.any(Headers),
      })
    );
    const requestOptions = fetchMock.mock.calls[0]?.[1] as { headers: Headers };
    expect(requestOptions.headers.get("Authorization")).toBe("Bearer token-1");
  });

  it("sends keepalive status update with serialized body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    api.updateCallStatusKeepalive("call-1", "ended");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/calls/call-1/status",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ status: "ended" }),
        credentials: "include",
        keepalive: true,
        headers: expect.any(Headers),
      })
    );
  });

  it("loads and updates push preferences through typed helpers", async () => {
    const preferences: PushPreferencesDto = {
      directMessagesEnabled: true,
      groupMessagesEnabled: true,
      callInvitesEnabled: true,
      showSender: false,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(preferences), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(preferences), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getPushPreferences()).resolves.toEqual(preferences);
    await expect(api.updatePushPreferences(preferences)).resolves.toEqual(preferences);
  });

  it("lists and revokes push subscriptions through typed helpers", async () => {
    const subscriptions: PushSubscriptionDto[] = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        endpoint: "https://push.example/subscription-1",
        userAgent: "Chrome Test",
        createdAt: "2026-03-10T12:00:00.000Z",
        updatedAt: "2026-03-10T12:10:00.000Z",
        lastSuccessAt: "2026-03-10T12:11:00.000Z",
        lastErrorAt: null,
        currentDevice: true,
      },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ subscriptions }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.listPushSubscriptions()).resolves.toEqual(subscriptions);
    await expect(
      api.deletePushSubscription("11111111-1111-4111-8111-111111111111")
    ).resolves.toBeUndefined();
  });

  it("passes an abort signal to fetch so a hung metadata request can be bounded", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.get<{ ok: boolean }>("/health");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("propagates a caller-provided abort without converting it to a timeout", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(abortError));
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = api.get("/health", { signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toBe(abortError);
  });
});
