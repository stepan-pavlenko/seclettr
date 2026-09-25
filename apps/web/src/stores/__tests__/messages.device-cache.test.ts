import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as MessagesStore from "@/stores/messages";

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const wsSendMock = vi.fn();

const mockAuthState = {
  userId: "user-self",
  deviceId: "device-self",
  storageKey: {} as CryptoKey,
  identityDhKeyPair: {
    publicKey: new Uint8Array(32).fill(1),
    privateKey: new Uint8Array(32).fill(2),
  },
};

const serializedSession = {
  DHs_pub: Buffer.from([1]).toString("base64url"),
  DHs_priv: Buffer.from([2]).toString("base64url"),
  DHr: Buffer.from([3]).toString("base64url"),
  RK: Buffer.alloc(32, 4).toString("base64url"),
  CKs: Buffer.alloc(32, 5).toString("base64url"),
  CKr: Buffer.alloc(32, 6).toString("base64url"),
  Ns: 0,
  Nr: 0,
  PN: 0,
  MKSKIPPED: [] as Array<[string, string]>,
};

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message);
      this.name = "ApiError";
    }
  },
  api: {
    get: apiGetMock,
    post: apiPostMock,
  },
}));

vi.mock("@/lib/websocket", () => ({
  wsClient: {
    connected: false,
    send: wsSendMock,
    on: () => () => {},
    onConnectionChange: () => () => {},
  },
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: {
    getState: () => mockAuthState,
  },
}));

vi.mock("@/lib/user-labels", () => ({
  fetchUserLabel: vi.fn(),
  getCachedUserLabel: vi.fn(() => null),
  primeUserLabelCache: vi.fn(),
  shouldHydrateUserLabel: vi.fn(() => false),
}));

vi.mock("@/lib/group-sender-key", () => ({
  importSenderKeyDistribution: vi.fn(),
}));

vi.mock("@/lib/direct-envelope", () => ({
  decodeDirectEnvelope: vi.fn(),
  encodeDirectEnvelope: vi.fn(() => "encoded-envelope"),
}));

vi.mock("@/lib/message-ack", () => ({
  postMessageAck: vi.fn(),
}));

vi.mock("@seclettr/crypto", () => ({
  x3dhSend: vi.fn(),
  initSender: vi.fn(),
  initReceiver: vi.fn(),
  ratchetEncrypt: vi.fn(async () => ({
    header: { pn: 0, n: 0 },
    ciphertext: new Uint8Array([9, 9, 9]),
  })),
  ratchetDecrypt: vi.fn(),
  bootstrapReceiverSession: vi.fn(),
  generateKeyPair: vi.fn(),
  generateOneTimePreKeys: vi.fn(),
  encryptAttachment: vi.fn(),
  toBase64Url: (value: Uint8Array) => Buffer.from(value).toString("base64url"),
  fromBase64Url: (value: string) =>
    new Uint8Array(Buffer.from(value, "base64url")),
  storeEncrypted: vi.fn(async () => {}),
  loadDecrypted: vi.fn(
    async <T>(_: CryptoKey, key: string): Promise<T | null> => {
      if (key.startsWith("session:device-peer")) {
        return serializedSession as T;
      }
      return null;
    }
  ),
  restoreKeyPairFromPrivateKey: vi.fn(
    async (privateKey: Uint8Array, publicKey?: Uint8Array) => ({
      publicKey: publicKey
        ? new Uint8Array(publicKey)
        : new Uint8Array(privateKey),
      privateKey,
    })
  ),
  deserializeRatchetState: vi.fn(async (s: any) => {
    const fromB64 = (str: string) => new Uint8Array(Buffer.from(str, "base64url"));
    return {
      DHs: { publicKey: s.DHs_pub ? fromB64(s.DHs_pub) : fromB64(s.DHs_priv), privateKey: fromB64(s.DHs_priv) },
      DHr: s.DHr ? fromB64(s.DHr) : null,
      RK: fromB64(s.RK),
      CKs: s.CKs ? fromB64(s.CKs) : null,
      CKr: s.CKr ? fromB64(s.CKr) : null,
      Ns: s.Ns, Nr: s.Nr, PN: s.PN,
      MKSKIPPED: new Map((s.MKSKIPPED ?? []).map(([k, v]: [string, string]) => [k, fromB64(v)])),
    };
  }),
  serializeRatchetState: vi.fn(() => serializedSession),
}));

let useMessagesStore: typeof MessagesStore.useMessagesStore;

describe("useMessagesStore recipient device cache", () => {
  beforeAll(async () => {
    Object.defineProperty(globalThis, "location", {
      value: { protocol: "https:", host: "localhost:5175" },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: {
        setTimeout,
        clearTimeout,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
      },
      configurable: true,
    });

    ({ useMessagesStore } = await import("@/stores/messages"));
  });

  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    wsSendMock.mockReset();

    useMessagesStore.setState({
      conversations: {},
      activeConversationId: null,
      pendingSessions: new Set(),
      processedMessageIds: new Set(),
      pendingAckMessageIds: new Set(),
      quarantinedMessageIds: new Set(),
      presenceByUser: {},
      typingByUser: {},
    });
  });

  it("reuses cached recipient device list for consecutive direct sends", async () => {
    apiGetMock.mockResolvedValue({
      devices: [
        { deviceId: "device-self", identityKeyPublic: "identity-self" },
        { deviceId: "device-peer", identityKeyPublic: "identity-peer" },
      ],
    });
    apiPostMock.mockResolvedValue({});

    await useMessagesStore.getState().sendMessage("user-peer", "first");
    await useMessagesStore.getState().sendMessage("user-peer", "second");

    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock.mock.calls.map((call) => call[0])).toEqual([
      "/messages",
      "/messages",
    ]);
    expect(apiPostMock).toHaveBeenNthCalledWith(
      1,
      "/messages",
      expect.objectContaining({
        recipientUserId: "user-peer",
        messages: [
          expect.objectContaining({ recipientDeviceId: "device-peer" }),
        ],
      })
    );
  });

  it("forces one refresh when cached list contains no deliverable recipient device", async () => {
    apiGetMock
      .mockResolvedValueOnce({
        devices: [
          { deviceId: "device-self", identityKeyPublic: "identity-self" },
        ],
      })
      .mockResolvedValueOnce({
        devices: [
          { deviceId: "device-self", identityKeyPublic: "identity-self" },
          { deviceId: "device-peer", identityKeyPublic: "identity-peer" },
        ],
      });
    apiPostMock.mockResolvedValue({});

    await useMessagesStore
      .getState()
      .sendMessage("user-peer-refresh", "hello after refresh");

    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(apiPostMock.mock.calls.map((call) => call[0])).toEqual([
      "/messages",
    ]);
  });

  it("sends sender-key distribution over the versioned direct-message contract", async () => {
    apiGetMock.mockResolvedValue({
      devices: [
        { deviceId: "device-self", identityKeyPublic: "identity-self" },
        { deviceId: "device-peer", identityKeyPublic: "identity-peer" },
      ],
    });
    apiPostMock.mockResolvedValue({});

    await expect(
      useMessagesStore.getState().sendSenderKeyDistribution("user-peer", {
        schemaVersion: 1,
        type: "sender_key_distribution",
        groupId: "11111111-1111-4111-8111-111111111111",
        senderDeviceId: "22222222-2222-4222-8222-222222222222",
        distributionId: "33333333-3333-4333-8333-333333333333",
        chainId: 0,
        chainKey: "chain-key-material",
        signingKey: "signing-key-material",
      })
    ).resolves.toEqual(["device-peer"]);

    expect(apiPostMock).toHaveBeenCalledWith(
      "/messages",
      expect.objectContaining({
        version: 1,
        recipientUserId: "user-peer",
        messages: [
          expect.objectContaining({
            recipientDeviceId: "device-peer",
            type: "sender_key_distribution",
          }),
        ],
      })
    );
  });

  it("hard-fails on unexpected peer identity change until the user re-verifies the contact", async () => {
    const recipientUserId = "user-peer-trust";
    apiGetMock.mockImplementation(async (path: string) => {
      if (path === "/messages/pending") {
        return { version: 1, messages: [] };
      }
      return {
        devices: [
          { deviceId: "device-self", identityKeyPublic: "identity-self" },
          { deviceId: "device-peer", identityKeyPublic: "identity-new" },
        ],
      };
    });
    apiPostMock.mockResolvedValue({});
    useMessagesStore.setState({
      conversations: {
        [recipientUserId]: {
          userId: recipientUserId,
          username: recipientUserId,
          messages: [],
          lastMessageAt: 0,
          unreadCount: 0,
          peerIdentityByDevice: {
            "device-peer": "identity-old",
          },
          peerIdentityDeviceId: "device-peer",
          peerIdentityKey: "identity-old",
        },
      },
    });

    await expect(
      useMessagesStore.getState().sendMessage(recipientUserId, "hello")
    ).rejects.toMatchObject({
      name: "PeerIdentityContinuityError",
    });

    const blockedConversation =
      useMessagesStore.getState().conversations[recipientUserId];
    expect(
      blockedConversation?.peerIdentityAlertsByDevice?.["device-peer"]
    ).toMatchObject({
      previousIdentityKey: "identity-old",
      currentIdentityKey: "identity-new",
    });
    expect(apiPostMock).not.toHaveBeenCalled();

    await useMessagesStore
      .getState()
      .acceptPeerIdentityChange(recipientUserId, "device-peer");

    expect(
      useMessagesStore.getState().conversations[recipientUserId]
        ?.peerIdentityAlertsByDevice
    ).toBeUndefined();
    expect(
      useMessagesStore.getState().conversations[recipientUserId]
        ?.peerIdentityByDevice?.["device-peer"]
    ).toBe("identity-new");

    apiPostMock.mockClear();

    await expect(
      useMessagesStore.getState().sendMessage(recipientUserId, "hello again")
    ).resolves.toBeUndefined();

    expect(apiPostMock.mock.calls.map((call) => call[0])).toEqual([
      "/messages",
    ]);
  });
});
