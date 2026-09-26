/**
 * Unit tests for the @seclettr/crypto package.
 *
 * Tests cover:
 *  - Key generation
 *  - X3DH shared secret agreement (both sides match)
 *  - Double Ratchet: bidirectional message exchange
 *  - Out-of-order message decryption
 *  - Attachment encryption / decryption
 *  - Sender Key group protocol
 */
import { describe, it, expect, beforeAll } from "vitest";
import { ensureSodium } from "../sodium.js";
import {
  generateKeyPair,
  generateIdentityBundle,
  generateSignedPreKey,
  generateOneTimePreKeys,
  restoreKeyPairFromPrivateKey,
  toBase64Url,
  fromBase64Url,
} from "../keys.js";
import {
  bootstrapReceiverSession,
  x3dhSend,
  x3dhReceive,
} from "../x3dh.js";
import {
  initSender,
  initReceiver,
  ratchetEncrypt,
  ratchetDecrypt,
  aeadEncrypt,
  aeadDecrypt,
} from "../double-ratchet.js";
import {
  generateSenderKey,
  MAX_SENDER_KEY_SKIP,
  senderKeyEncrypt,
  senderKeyDecrypt,
  serializeSenderKeyState,
  deserializeSenderKeyState,
} from "../sender-keys.js";
import { encryptAttachment, decryptAttachment } from "../attachment.js";
import {
  generateStorageKey,
  loadDecrypted,
  storeBytes,
  storeEncrypted,
  type StorageLoadError,
} from "../storage.js";

// libsodium must be initialised before any test
beforeAll(async () => {
  installFakeIndexedDb();
  await ensureSodium();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

function str(bytes: Uint8Array): string {
  return dec.decode(bytes);
}

function installFakeIndexedDb(): void {
  if (typeof indexedDB !== "undefined") {
    return;
  }

  const records = new Map<string, Uint8Array>();
  let hasKeystore = false;

  const db = createFakeCryptoDb(records, {
    hasKeystore: () => hasKeystore,
    markKeystoreCreated: () => {
      hasKeystore = true;
    },
  });

  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open: (_name: string, _version: number) => {
        const request = {
          result: db,
          error: null as unknown,
          onsuccess: null as ((event: { target: unknown }) => void) | null,
          onerror: null as ((event: { target: unknown }) => void) | null,
          onupgradeneeded: null as ((event: { target: unknown }) => void) | null,
        };

        queueMicrotask(() => {
          request.onupgradeneeded?.({ target: request });
          request.onsuccess?.({ target: request });
        });

        return request;
      },
    },
  });
}

function createFakeCryptoDb(
  records: Map<string, Uint8Array>,
  storeState: { hasKeystore: () => boolean; markKeystoreCreated: () => void }
) {
  return {
    objectStoreNames: {
      contains: (name: string) => storeState.hasKeystore() && name === "keystore",
    },
    createObjectStore: (_name: string) => {
      storeState.markKeystoreCreated();
      return {};
    },
    transaction: (_name: string, _mode: string) => ({
      objectStore: () => createFakeCryptoObjectStore(records),
    }),
  };
}

function createFakeCryptoObjectStore(records: Map<string, Uint8Array>) {
  return {
    get: (key: string) => createFakeCryptoRequest(() => records.get(key) ?? null),
    put: (value: Uint8Array, key: string) =>
      createFakeCryptoRequest(() => {
        records.set(key, value);
        return key;
      }),
  };
}

function createFakeCryptoRequest<T>(run: () => T) {
  const request = {
    result: undefined as T | undefined,
    error: null as unknown,
    onsuccess: null as ((event: { target: unknown }) => void) | null,
    onerror: null as ((event: { target: unknown }) => void) | null,
    onupgradeneeded: null as ((event: { target: unknown }) => void) | null,
  };

  queueMicrotask(() => {
    try {
      request.result = run();
      request.onsuccess?.({ target: request });
    } catch (error) {
      request.error = error;
      request.onerror?.({ target: request });
    }
  });

  return request;
}

// ─── Key generation ───────────────────────────────────────────────────────────

describe("Key generation", () => {
  it("generates a 32-byte X25519 keypair", async () => {
    const kp = await generateKeyPair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
  });

  it("generates distinct keypairs", async () => {
    const kp1 = await generateKeyPair();
    const kp2 = await generateKeyPair();
    expect(toBase64Url(kp1.publicKey)).not.toBe(toBase64Url(kp2.publicKey));
  });

  it("generates identity bundle with DH + signing keypairs", async () => {
    const bundle = await generateIdentityBundle();
    expect(bundle.dhKeyPair.publicKey.length).toBe(32);
    expect(bundle.signingKeyPair.publicKey.length).toBe(32);
    expect(bundle.signingKeyPair.privateKey.length).toBe(64); // Ed25519 private is 64 bytes in libsodium
  });

  it("generates signed prekey with valid Ed25519 signature", async () => {
    const sodium = await ensureSodium();
    const identity = await generateIdentityBundle();
    const spk = await generateSignedPreKey(1, identity.signingKeyPair.privateKey);
    const valid = sodium.crypto_sign_verify_detached(
      spk.signature, spk.publicKey, identity.signingKeyPair.publicKey
    );
    expect(valid).toBe(true);
  });

  it("generates OTK pool with correct IDs", async () => {
    const otks = await generateOneTimePreKeys(100, 10);
    expect(otks).toHaveLength(10);
    expect(otks[0]?.id).toBe(100);
    expect(otks[9]?.id).toBe(109);
    otks.forEach(otk => {
      expect(otk.publicKey.length).toBe(32);
    });
  });
});

// ─── base64url ────────────────────────────────────────────────────────────────

describe("base64url encode/decode", () => {
  it("round-trips correctly", () => {
    const original = crypto.getRandomValues(new Uint8Array(32));
    const encoded = toBase64Url(original);
    const decoded = fromBase64Url(encoded);
    expect(decoded).toEqual(original);
  });

  it("uses URL-safe characters (no +, /, =)", () => {
    for (let i = 0; i < 100; i++) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const encoded = toBase64Url(bytes);
      expect(encoded).not.toMatch(/[+/=]/);
    }
  });
});

describe("key restoration", () => {
  it("derives the original X25519 public key from the private key", async () => {
    const original = await generateKeyPair();
    const restored = await restoreKeyPairFromPrivateKey(original.privateKey);

    expect(restored.publicKey).toEqual(original.publicKey);
    expect(restored.publicKey).not.toEqual(new Uint8Array(32));
  });
});

// ─── X3DH ────────────────────────────────────────────────────────────────────

describe("X3DH key agreement", () => {
  it("produces identical shared secrets for sender and receiver (with OTK)", async () => {
    const alice = await generateIdentityBundle();
    const bob = await generateIdentityBundle();
    const spk = await generateSignedPreKey(1, bob.signingKeyPair.privateKey);
    const otks = await generateOneTimePreKeys(1, 1);
    const otk = otks[0]!;

    const aliceEphemeral = await generateKeyPair();

    const aliceResult = await x3dhSend(alice.dhKeyPair, aliceEphemeral, {
      registrationId: 42,
      identityKey: bob.dhKeyPair.publicKey,
      signingKey: bob.signingKeyPair.publicKey,
      signedPreKey: { id: 1, publicKey: spk.publicKey, signature: spk.signature },
      oneTimePreKey: { id: 1, publicKey: otk.publicKey },
    });

    const bobResult = await x3dhReceive(
      bob.dhKeyPair,
      spk,
      otk,
      alice.dhKeyPair.publicKey,
      aliceEphemeral.publicKey
    );

    expect(toBase64Url(aliceResult.sharedSecret)).toBe(toBase64Url(bobResult.sharedSecret));
  });

  it("produces identical shared secrets without OTK", async () => {
    const alice = await generateIdentityBundle();
    const bob = await generateIdentityBundle();
    const spk = await generateSignedPreKey(1, bob.signingKeyPair.privateKey);
    const aliceEphemeral = await generateKeyPair();

    const aliceResult = await x3dhSend(alice.dhKeyPair, aliceEphemeral, {
      registrationId: 42,
      identityKey: bob.dhKeyPair.publicKey,
      signingKey: bob.signingKeyPair.publicKey,
      signedPreKey: { id: 1, publicKey: spk.publicKey, signature: spk.signature },
    });

    const bobResult = await x3dhReceive(
      bob.dhKeyPair,
      spk,
      undefined,
      alice.dhKeyPair.publicKey,
      aliceEphemeral.publicKey
    );

    expect(toBase64Url(aliceResult.sharedSecret)).toBe(toBase64Url(bobResult.sharedSecret));
  });

  it("rejects a prekey bundle with invalid signature", async () => {
    const alice = await generateIdentityBundle();
    const bob = await generateIdentityBundle();
    const eve = await generateIdentityBundle();
    const spk = await generateSignedPreKey(1, bob.signingKeyPair.privateKey);
    const aliceEphemeral = await generateKeyPair();

    await expect(
      x3dhSend(alice.dhKeyPair, aliceEphemeral, {
        registrationId: 42,
        identityKey: bob.dhKeyPair.publicKey,
        signingKey: eve.signingKeyPair.publicKey, // wrong signing key!
        signedPreKey: { id: 1, publicKey: spk.publicKey, signature: spk.signature },
      })
    ).rejects.toThrow("Invalid signed prekey signature");
  });
});

// ─── Double Ratchet ───────────────────────────────────────────────────────────

describe("Double Ratchet", () => {
  async function setupSession() {
    const alice = await generateIdentityBundle();
    const bob = await generateIdentityBundle();
    const spk = await generateSignedPreKey(1, bob.signingKeyPair.privateKey);
    const aliceEphemeral = await generateKeyPair();

    const { sharedSecret } = await x3dhSend(alice.dhKeyPair, aliceEphemeral, {
      registrationId: 42,
      identityKey: bob.dhKeyPair.publicKey,
      signingKey: bob.signingKeyPair.publicKey,
      signedPreKey: { id: 1, publicKey: spk.publicKey, signature: spk.signature },
    });

    const aliceState = await initSender(sharedSecret.slice(), spk.publicKey);
    const bobState = await initReceiver(sharedSecret.slice(), spk);
    sharedSecret.fill(0);

    const ad = enc.encode("alice:bob");
    return { aliceState, bobState, ad };
  }

  it("encrypts and decrypts a single message", async () => {
    const { aliceState, bobState, ad } = await setupSession();
    const plaintext = enc.encode("Hello, Bob!");

    const encrypted = await ratchetEncrypt(aliceState, plaintext, ad);
    const decrypted = await ratchetDecrypt(bobState, encrypted, ad);

    expect(str(decrypted)).toBe("Hello, Bob!");
  });

  it("supports multiple sequential messages Alice→Bob", async () => {
    const { aliceState, bobState, ad } = await setupSession();
    const messages = ["msg 1", "msg 2", "msg 3", "msg 4", "msg 5"];

    for (const msg of messages) {
      const enc_ = await ratchetEncrypt(aliceState, enc.encode(msg), ad);
      const dec_ = await ratchetDecrypt(bobState, enc_, ad);
      expect(str(dec_)).toBe(msg);
    }
  });

  it("supports bidirectional messaging", async () => {
    const { aliceState, bobState, ad } = await setupSession();

    const e1 = await ratchetEncrypt(aliceState, enc.encode("Hello from Alice"), ad);
    const d1 = await ratchetDecrypt(bobState, e1, ad);
    expect(str(d1)).toBe("Hello from Alice");

    const e2 = await ratchetEncrypt(bobState, enc.encode("Hi Alice!"), ad);
    const d2 = await ratchetDecrypt(aliceState, e2, ad);
    expect(str(d2)).toBe("Hi Alice!");

    const e3 = await ratchetEncrypt(aliceState, enc.encode("How are you?"), ad);
    const d3 = await ratchetDecrypt(bobState, e3, ad);
    expect(str(d3)).toBe("How are you?");
  });

  it("handles out-of-order messages", async () => {
    const { aliceState, bobState, ad } = await setupSession();

    const e1 = await ratchetEncrypt(aliceState, enc.encode("first"), ad);
    const e2 = await ratchetEncrypt(aliceState, enc.encode("second"), ad);
    const e3 = await ratchetEncrypt(aliceState, enc.encode("third"), ad);

    // Receive out of order: 3, 1, 2
    const d3 = await ratchetDecrypt(bobState, e3, ad);
    const d1 = await ratchetDecrypt(bobState, e1, ad);
    const d2 = await ratchetDecrypt(bobState, e2, ad);

    expect(str(d1)).toBe("first");
    expect(str(d2)).toBe("second");
    expect(str(d3)).toBe("third");
  });

  it("rejects tampered ciphertext", async () => {
    const { aliceState, bobState, ad } = await setupSession();
    const encrypted = await ratchetEncrypt(aliceState, enc.encode("secret"), ad);

    // Flip a byte in the ciphertext
    encrypted.ciphertext[0] ^= 0xff;

    await expect(ratchetDecrypt(bobState, encrypted, ad)).rejects.toThrow();
  });
});

describe("Receiver bootstrap", () => {
  async function setupReceiverBootstrapFixture(options?: { includeOtk?: boolean }) {
    const includeOtk = options?.includeOtk ?? true;
    const alice = await generateIdentityBundle();
    const bob = await generateIdentityBundle();
    const spk = await generateSignedPreKey(7, bob.signingKeyPair.privateKey);
    const otk = includeOtk ? (await generateOneTimePreKeys(11, 1))[0]! : undefined;
    const aliceEphemeral = await generateKeyPair();

    const senderX3dh = await x3dhSend(alice.dhKeyPair, aliceEphemeral, {
      registrationId: 42,
      identityKey: bob.dhKeyPair.publicKey,
      signingKey: bob.signingKeyPair.publicKey,
      signedPreKey: { id: spk.id, publicKey: spk.publicKey, signature: spk.signature },
      oneTimePreKey: otk ? { id: otk.id, publicKey: otk.publicKey } : undefined,
    });

    const senderState = await initSender(senderX3dh.sharedSecret.slice(), spk.publicKey);
    senderX3dh.sharedSecret.fill(0);

    const ad = enc.encode("alice-device:bob-device");
    const initialMessage = await ratchetEncrypt(senderState, enc.encode("bootstrap hello"), ad);
    const restoredSpk = {
      ...(await restoreKeyPairFromPrivateKey(spk.privateKey)),
      id: spk.id,
    };

    return {
      alice,
      aliceEphemeral,
      bob,
      ad,
      initialMessage,
      restoredSpk,
      senderState,
      otk,
    };
  }

  it("bootstraps receiver state from restored prekeys and decrypts the first inbound message", async () => {
    const fixture = await setupReceiverBootstrapFixture();
    const restoredOtk = {
      ...(await restoreKeyPairFromPrivateKey(fixture.otk!.privateKey)),
      id: fixture.otk!.id,
    };

    const bootstrap = await bootstrapReceiverSession({
      receiverIdentityKeyPair: fixture.bob.dhKeyPair,
      receiverSignedPreKeyPair: fixture.restoredSpk,
      receiverOneTimePreKeyPair: restoredOtk,
      senderIdentityPublicKey: fixture.alice.dhKeyPair.publicKey,
      senderEphemeralPublicKey: fixture.aliceEphemeral.publicKey,
      initialMessage: fixture.initialMessage,
      associatedData: fixture.ad,
    });

    expect(str(bootstrap.plaintext)).toBe("bootstrap hello");
    expect(bootstrap.consumedOneTimePreKeyId).toBe(fixture.otk!.id);
    expect(bootstrap.session.DHs.publicKey).not.toEqual(new Uint8Array(32));
  });

  it("fails receiver bootstrap before commit when the init message expects an OTK but none is available", async () => {
    const fixture = await setupReceiverBootstrapFixture();

    await expect(
      bootstrapReceiverSession({
        receiverIdentityKeyPair: fixture.bob.dhKeyPair,
        receiverSignedPreKeyPair: fixture.restoredSpk,
        receiverOneTimePreKeyPair: undefined,
        senderIdentityPublicKey: fixture.alice.dhKeyPair.publicKey,
        senderEphemeralPublicKey: fixture.aliceEphemeral.publicKey,
        initialMessage: fixture.initialMessage,
        associatedData: fixture.ad,
      })
    ).rejects.toThrow();
  });

  it("fails receiver bootstrap before commit when the stored OTK private half is corrupted", async () => {
    const fixture = await setupReceiverBootstrapFixture();
    const corruptedPrivateKey = new Uint8Array(fixture.otk!.privateKey);
    corruptedPrivateKey[0] ^= 0xff;
    const corruptedOtk = {
      ...(await restoreKeyPairFromPrivateKey(corruptedPrivateKey)),
      id: fixture.otk!.id,
    };

    await expect(
      bootstrapReceiverSession({
        receiverIdentityKeyPair: fixture.bob.dhKeyPair,
        receiverSignedPreKeyPair: fixture.restoredSpk,
        receiverOneTimePreKeyPair: corruptedOtk,
        senderIdentityPublicKey: fixture.alice.dhKeyPair.publicKey,
        senderEphemeralPublicKey: fixture.aliceEphemeral.publicKey,
        initialMessage: fixture.initialMessage,
        associatedData: fixture.ad,
      })
    ).rejects.toThrow();
  });

  it("keeps ratchet symmetry after receiver bootstrap and first outbound reply", async () => {
    const fixture = await setupReceiverBootstrapFixture();
    const restoredOtk = {
      ...(await restoreKeyPairFromPrivateKey(fixture.otk!.privateKey)),
      id: fixture.otk!.id,
    };

    const bootstrap = await bootstrapReceiverSession({
      receiverIdentityKeyPair: fixture.bob.dhKeyPair,
      receiverSignedPreKeyPair: fixture.restoredSpk,
      receiverOneTimePreKeyPair: restoredOtk,
      senderIdentityPublicKey: fixture.alice.dhKeyPair.publicKey,
      senderEphemeralPublicKey: fixture.aliceEphemeral.publicKey,
      initialMessage: fixture.initialMessage,
      associatedData: fixture.ad,
    });

    const reply = await ratchetEncrypt(
      bootstrap.session,
      enc.encode("bootstrap reply"),
      fixture.ad
    );
    const senderReceivedReply = await ratchetDecrypt(
      fixture.senderState,
      reply,
      fixture.ad
    );
    expect(str(senderReceivedReply)).toBe("bootstrap reply");

    const followUp = await ratchetEncrypt(
      fixture.senderState,
      enc.encode("post-bootstrap follow-up"),
      fixture.ad
    );
    const receiverFollowUp = await ratchetDecrypt(
      bootstrap.session,
      followUp,
      fixture.ad
    );
    expect(str(receiverFollowUp)).toBe("post-bootstrap follow-up");
  });
});

// ─── AEAD ─────────────────────────────────────────────────────────────────────

describe("AEAD (AES-256-GCM)", () => {
  it("encrypts and decrypts", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const plaintext = enc.encode("top secret");
    const ad = enc.encode("context");

    const ct = await aeadEncrypt(key, plaintext, ad);
    const pt = await aeadDecrypt(key, ct, ad);
    expect(str(pt)).toBe("top secret");
  });

  it("rejects wrong associated data", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const ct = await aeadEncrypt(key, enc.encode("msg"), enc.encode("real-ad"));
    await expect(aeadDecrypt(key, ct, enc.encode("wrong-ad"))).rejects.toThrow();
  });
});

// ─── Attachment encryption ────────────────────────────────────────────────────

describe("Attachment encryption", () => {
  it("encrypts and decrypts a binary blob", async () => {
    const plaintext = crypto.getRandomValues(new Uint8Array(1024));
    const { data, key, digest } = await encryptAttachment(plaintext, "image/png");

    expect(data.length).toBeGreaterThan(plaintext.length); // IV + ciphertext + tag
    const decrypted = await decryptAttachment(data, key, digest);
    expect(decrypted).toEqual(plaintext);
  });

  it("detects tampered ciphertext via digest check", async () => {
    const plaintext = enc.encode("important file");
    const { data, key, digest } = await encryptAttachment(plaintext, "text/plain");

    const tampered = new Uint8Array(data);
    tampered[15] ^= 0xff;

    await expect(decryptAttachment(tampered, key, digest)).rejects.toThrow(
      "Attachment integrity check failed"
    );
  });

  it("uses a unique key for each file", async () => {
    const pt = enc.encode("file content");
    const a = await encryptAttachment(pt, "text/plain");
    const b = await encryptAttachment(pt, "text/plain");
    expect(toBase64Url(a.key)).not.toBe(toBase64Url(b.key));
  });
});

describe("Encrypted storage", () => {
  it("returns null and reports decrypt failures without throwing", async () => {
    const { key: writeKey } = await generateStorageKey();
    const { key: wrongKey } = await generateStorageKey();
    const itemKey = `storage:${crypto.randomUUID()}`;
    const errors: StorageLoadError[] = [];

    await storeEncrypted(writeKey, itemKey, { ok: true });
    const loaded = await loadDecrypted<{ ok: boolean }>(wrongKey, itemKey, {
      onError: (error) => errors.push(error),
    });

    expect(loaded).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("decrypt_failed");
    expect(errors[0]?.itemKey).toBe(itemKey);
  });

  it("returns null and reports invalid JSON payloads", async () => {
    const { key } = await generateStorageKey();
    const itemKey = `storage:${crypto.randomUUID()}`;
    const errors: StorageLoadError[] = [];

    await storeBytes(key, itemKey, enc.encode("not-json"));
    const loaded = await loadDecrypted(key, itemKey, {
      onError: (error) => errors.push(error),
    });

    expect(loaded).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("invalid_json");
    expect(errors[0]?.itemKey).toBe(itemKey);
  });
});

// ─── Sender Keys ──────────────────────────────────────────────────────────────

describe("Sender Keys (group protocol)", () => {
  const distributionId = "test-group-dist-id";

  it("encrypts and decrypts a group message", async () => {
    const state = await generateSenderKey();
    const receiverState = { ...state, signingPrivateKey: undefined };

    const plaintext = enc.encode("Hello group!");
    const { message, newState } = await senderKeyEncrypt(state, distributionId, plaintext);
    const { plaintext: decrypted } = await senderKeyDecrypt(receiverState, message);

    expect(str(decrypted)).toBe("Hello group!");
    expect(newState.chainId).toBe(state.chainId + 1);
  });

  it("advances chain with sequential messages", async () => {
    let senderState = await generateSenderKey();
    const receiverState = { ...senderState, signingPrivateKey: undefined };

    const messages = [];
    for (let i = 0; i < 5; i++) {
      const { message, newState } = await senderKeyEncrypt(
        senderState, distributionId, enc.encode(`message ${i}`)
      );
      senderState = newState;
      messages.push(message);
    }

    let recvState = receiverState;
    for (let i = 0; i < 5; i++) {
      const { plaintext, newState } = await senderKeyDecrypt(recvState, messages[i]!);
      recvState = newState;
      expect(str(plaintext)).toBe(`message ${i}`);
    }
  });

  it("rejects a message with an invalid signature", async () => {
    const state = await generateSenderKey();
    const eveState = await generateSenderKey(); // different signing key
    const receiverState = { ...state, signingPrivateKey: undefined };

    const { message } = await senderKeyEncrypt(eveState, distributionId, enc.encode("tampered"));
    // Use the message but with the real state's signing public key → mismatch
    await expect(senderKeyDecrypt(receiverState, message)).rejects.toThrow(
      "Invalid group message signature"
    );
  });

  it("accepts the maximum allowed sender-key skip window", async () => {
    let senderState = await generateSenderKey();
    const receiverState = { ...senderState, signingPrivateKey: undefined };

    let lastMessage = null;
    for (let i = 0; i <= MAX_SENDER_KEY_SKIP; i++) {
      const encrypted = await senderKeyEncrypt(
        senderState,
        distributionId,
        enc.encode(`message ${i}`)
      );
      senderState = encrypted.newState;
      lastMessage = encrypted.message;
    }

    expect(lastMessage).not.toBeNull();
    const { plaintext, newState } = await senderKeyDecrypt(receiverState, lastMessage!);
    expect(str(plaintext)).toBe(`message ${MAX_SENDER_KEY_SKIP}`);
    expect(newState.chainId).toBe(MAX_SENDER_KEY_SKIP + 1);
  });

  it("fails fast when sender-key message gap exceeds the limit", async () => {
    let senderState = await generateSenderKey();
    const receiverState = { ...senderState, signingPrivateKey: undefined };

    let oversizedMessage = null;
    for (let i = 0; i <= MAX_SENDER_KEY_SKIP + 1; i++) {
      const encrypted = await senderKeyEncrypt(
        senderState,
        distributionId,
        enc.encode(`message ${i}`)
      );
      senderState = encrypted.newState;
      oversizedMessage = encrypted.message;
    }

    expect(oversizedMessage).not.toBeNull();
    await expect(senderKeyDecrypt(receiverState, oversizedMessage!)).rejects.toThrow(
      "Too many skipped sender key messages"
    );
  });

  it("decrypts out-of-order messages using the MKSKIPPED cache", async () => {
    let senderState = await generateSenderKey();
    let recvState = { ...senderState, signingPrivateKey: undefined };

    // Encrypt three messages but deliver them out of order: 2, 0, 1.
    const enc0 = await senderKeyEncrypt(senderState, distributionId, enc.encode("msg-0"));
    senderState = enc0.newState;
    const enc1 = await senderKeyEncrypt(senderState, distributionId, enc.encode("msg-1"));
    senderState = enc1.newState;
    const enc2 = await senderKeyEncrypt(senderState, distributionId, enc.encode("msg-2"));

    // Decrypt msg-2 first — causes msg-0 and msg-1 keys to be cached.
    const d2 = await senderKeyDecrypt(recvState, enc2.message);
    recvState = d2.newState;
    expect(str(d2.plaintext)).toBe("msg-2");

    // Now decrypt msg-0 from the MKSKIPPED cache.
    const d0 = await senderKeyDecrypt(recvState, enc0.message);
    recvState = d0.newState;
    expect(str(d0.plaintext)).toBe("msg-0");

    // And msg-1.
    const d1 = await senderKeyDecrypt(recvState, enc1.message);
    expect(str(d1.plaintext)).toBe("msg-1");
  });

  it("does not corrupt caller-owned MKSKIPPED state when decrypting a cached key", async () => {
    let senderState = await generateSenderKey();
    const recvState = { ...senderState, signingPrivateKey: undefined };

    const enc0 = await senderKeyEncrypt(senderState, distributionId, enc.encode("cached-0"));
    senderState = enc0.newState;
    const enc1 = await senderKeyEncrypt(senderState, distributionId, enc.encode("cached-1"));

    // Receive msg-1 first so msg-0's key is cached in recvState.MKSKIPPED.
    const d1 = await senderKeyDecrypt(recvState, enc1.message);
    const skipKey = `${distributionId}:${enc0.message.messageId}`;
    const cachedBefore = d1.newState.MKSKIPPED.get(skipKey);
    expect(cachedBefore).toBeDefined();
    const snapshot = Uint8Array.from(cachedBefore!);

    // Decrypt msg-0 via the fast path. This must not mutate the caller's
    // retained MKSKIPPED entry (AUDIT.md H14).
    const d0 = await senderKeyDecrypt(d1.newState, enc0.message);
    expect(str(d0.plaintext)).toBe("cached-0");
    expect(Array.from(d1.newState.MKSKIPPED.get(skipKey)!)).toEqual(Array.from(snapshot));
    expect(d1.newState.MKSKIPPED.get(skipKey)!.some((b) => b !== 0)).toBe(true);
  });

  it("uses aeadVersion=1 for new messages and correctly uses empty AD for aeadVersion=0", async () => {
    const senderState = await generateSenderKey();
    const recvState = { ...senderState, signingPrivateKey: undefined };

    const { message } = await senderKeyEncrypt(senderState, distributionId, enc.encode("hello"));
    expect(message.aeadVersion).toBe(1);

    // Decrypting with the correct aeadVersion succeeds.
    const { plaintext } = await senderKeyDecrypt(recvState, message);
    expect(str(plaintext)).toBe("hello");

    // Forcing aeadVersion=0 on a v1-encrypted message must fail (wrong AD).
    await expect(
      senderKeyDecrypt({ ...recvState }, { ...message, aeadVersion: 0 })
    ).rejects.toThrow();
  });

  it("round-trips state through serialize/deserialize", async () => {
    let senderState = await generateSenderKey();
    let recvState = { ...senderState, signingPrivateKey: undefined };

    // Encrypt a few messages and leave some out-of-order to populate MKSKIPPED.
    const enc0 = await senderKeyEncrypt(senderState, distributionId, enc.encode("a"));
    senderState = enc0.newState;
    const enc1 = await senderKeyEncrypt(senderState, distributionId, enc.encode("b"));
    senderState = enc1.newState;
    const enc2 = await senderKeyEncrypt(senderState, distributionId, enc.encode("c"));

    // Receive enc2 first to populate MKSKIPPED.
    const d2 = await senderKeyDecrypt(recvState, enc2.message);
    recvState = d2.newState;

    // Serialize and deserialize the receiver state.
    const serialized = serializeSenderKeyState(recvState);
    const restored = deserializeSenderKeyState(serialized);

    // The restored state should still be able to decrypt the cached messages.
    const dr0 = await senderKeyDecrypt(restored, enc0.message);
    expect(str(dr0.plaintext)).toBe("a");
    const dr1 = await senderKeyDecrypt(dr0.newState, enc1.message);
    expect(str(dr1.plaintext)).toBe("b");
  });

  it("deserializes state without MKSKIPPED field (legacy stored state)", async () => {
    const state = await generateSenderKey();
    const serialized = serializeSenderKeyState(state);
    // Simulate legacy storage that lacks the MKSKIPPED field.
    const legacy = { ...serialized, MKSKIPPED: undefined } as unknown as typeof serialized;
    const restored = deserializeSenderKeyState(legacy);
    expect(restored.MKSKIPPED.size).toBe(0);
  });
});
