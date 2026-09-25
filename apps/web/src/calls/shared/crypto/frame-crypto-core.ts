/**
 * frame-crypto-core — AES-256-GCM frame encryption primitives and key-state management.
 *
 * Owns:
 *   - Type definitions: FrameCryptoDirection, EncodedFrame, GroupCallFrameCryptoContext,
 *     MutableKeyState, GroupCallFrameKeyContext, GroupCallFrameKeyInput,
 *     FrameCryptoRuntime, and all Worker message types
 *   - Frame wire format: NEXT_FRAME_MAGIC (SDFEP) + legacy FRAME_MAGIC (QMGC\x01) magic bytes,
 *     12-byte IV prefix, 16-byte AES-GCM auth tag
 *   - buildAssociatedData — derives AEAD additional data from roomId:deviceId:kind:source
 *   - normalizeKeyInput — converts Uint8Array | GroupCallFrameKeyContext[] | null to MutableKeyState[]
 *   - clearMutableKeyStates — zeroes raw key material on pipeline teardown
 *   - processFrameBuffer — the hot path: encrypts (send) or tries all key contexts (recv)
 *   - encryptGroupCallFramePayload / decryptGroupCallFramePayload — one-shot test/util helpers
 *   - cloneKeyContext / cloneKeyInputContexts — deep copies for safe key handoff across threads
 *   - startsWithMagic — identifies encrypted frames by magic-byte prefix
 *
 * Does not own transport binding (see frame-crypto.ts), Worker entry point
 * (see frame-crypto.worker.ts), or capability detection (see frame-crypto-capabilities.ts).
 *
 * Invariant: raw key bytes in MutableKeyState are always zeroed via clearMutableKeyStates
 * before the array is discarded — never left resident in memory.
 */
import type { SfuProducerSource } from "@seclettr/protocol";

export type FrameCryptoDirection = "send" | "recv";

export type EncodedFrame = {
  data: ArrayBuffer;
};

export interface GroupCallFrameCryptoContext {
  roomId: string;
  deviceId: string;
  kind: "audio" | "video";
  source?: SfuProducerSource | null;
}

export interface MutableKeyState {
  keyId: string;
  epoch: number | null;
  rawKey: Uint8Array | null;
  importedKey: Promise<CryptoKey> | null;
  importedKeyFingerprint: string | null;
}

export interface GroupCallFrameKeyContext {
  keyId: string;
  epoch: number | null;
  keyBytes: Uint8Array;
}

export type GroupCallFrameKeyInput =
  | Uint8Array
  | readonly GroupCallFrameKeyContext[]
  | null;

export interface FrameCryptoRuntime {
  direction: FrameCryptoDirection;
  additionalData: Uint8Array;
  keyStates: MutableKeyState[];
  /**
   * When true the pipeline is fail-closed: it never emits or accepts a
   * plaintext frame. In `required` mode the sender drops frames until a key is
   * armed and the receiver drops any non-magic frame instead of trusting it.
   * When false (best-effort) legacy plaintext passthrough is preserved for
   * mixed-version rollout.
   */
  requireEncryption?: boolean;
}

export interface FrameCryptoWorkerConfigMessage {
  type: "configure";
  handleId: string;
  direction: FrameCryptoDirection;
  context: GroupCallFrameCryptoContext;
  keyContexts: readonly GroupCallFrameKeyContext[];
  requireEncryption?: boolean;
}

export interface FrameCryptoWorkerCloseMessage {
  type: "close";
  handleId: string;
}

export interface FrameCryptoWorkerPipelineFailedMessage {
  type: "pipeline-failed";
  handleId: string;
}

export type FrameCryptoWorkerMessage =
  | FrameCryptoWorkerConfigMessage
  | FrameCryptoWorkerCloseMessage;

export type FrameCryptoWorkerEventMessage = FrameCryptoWorkerPipelineFailedMessage;

// Keep legacy transmit framing until the peer negotiates frame header/version
// support. The parser accepts both markers during rollout.
const NEXT_FRAME_MAGIC = new Uint8Array([0x53, 0x44, 0x46, 0x45, 0x50]); // SDFEP
const FRAME_MAGIC = new Uint8Array([0x51, 0x4d, 0x47, 0x43, 0x01]); // QMGC\x01 - legacy tag from first project iteration, kept for compatibility with rolled out clients.
const FRAME_IV_LENGTH = 12;
const FRAME_AUTH_TAG_LENGTH = 16;
const MIN_ENCRYPTED_FRAME_LENGTH = FRAME_MAGIC.length + FRAME_IV_LENGTH + FRAME_AUTH_TAG_LENGTH;

export function cloneKeyContext(context: GroupCallFrameKeyContext): GroupCallFrameKeyContext {
  return {
    keyId: context.keyId,
    epoch: context.epoch,
    keyBytes: Uint8Array.from(context.keyBytes),
  };
}

function fingerprintKeyBytes(keyBytes: Uint8Array): string {
  return Array.from(keyBytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function buildAssociatedData(context: GroupCallFrameCryptoContext): Uint8Array {
  return new TextEncoder().encode(
    `seclettr.group-call.frame:${context.roomId}:${context.deviceId}:${context.kind}:${context.source ?? "-"}`
  );
}

function matchesMagic(data: Uint8Array, magic: Uint8Array): boolean {
  if (data.length < magic.length) return false;
  for (let index = 0; index < magic.length; index += 1) {
    if (data[index] !== magic[index]) {
      return false;
    }
  }
  return true;
}

export function startsWithMagic(data: Uint8Array): boolean {
  return matchesMagic(data, FRAME_MAGIC) || matchesMagic(data, NEXT_FRAME_MAGIC);
}

function toExactArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}

async function importAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toExactArrayBuffer(rawKey), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function resolveImportedKey(state: MutableKeyState): Promise<CryptoKey | null> {
  const { rawKey } = state;
  if (!rawKey) return null;

  const nextFingerprint = fingerprintKeyBytes(rawKey);
  if (!state.importedKey || state.importedKeyFingerprint !== nextFingerprint) {
    const promise = importAesKey(rawKey);
    state.importedKey = promise;
    state.importedKeyFingerprint = nextFingerprint;
    // Clear the cached promise on rejection so the next frame retries import
    // rather than re-awaiting the permanently-rejected Promise.
    promise.catch(() => {
      if (state.importedKey === promise) {
        state.importedKey = null;
        state.importedKeyFingerprint = null;
      }
    });
  }

  try {
    return await state.importedKey;
  } catch {
    return null;
  }
}

function createAnonymousKeyContext(keyBytes: Uint8Array): GroupCallFrameKeyContext {
  return {
    keyId: fingerprintKeyBytes(keyBytes),
    epoch: null,
    keyBytes: Uint8Array.from(keyBytes),
  };
}

export function cloneKeyInputContexts(input: GroupCallFrameKeyInput): GroupCallFrameKeyContext[] {
  const keyStates = normalizeKeyInput(input);
  try {
    return keyStates.map((state) => ({
      keyId: state.keyId,
      epoch: state.epoch,
      keyBytes: Uint8Array.from(state.rawKey ?? new Uint8Array()),
    }));
  } finally {
    clearMutableKeyStates(keyStates);
  }
}

export function clearMutableKeyStates(keyStates: MutableKeyState[]): void {
  for (const state of keyStates) {
    state.rawKey?.fill(0);
    state.rawKey = null;
    state.importedKey = null;
    state.importedKeyFingerprint = null;
  }
}

export function normalizeKeyInput(input: GroupCallFrameKeyInput): MutableKeyState[] {
  if (!input) {
    return [];
  }

  const contexts = input instanceof Uint8Array
    ? [createAnonymousKeyContext(input)]
    : input;

  return contexts
    .filter((context) => context.keyBytes.length > 0)
    .map((context) => {
      const cloned = cloneKeyContext(context);
      return {
        keyId: cloned.keyId,
        epoch: cloned.epoch,
        rawKey: cloned.keyBytes,
        importedKey: null,
        importedKeyFingerprint: null,
      } satisfies MutableKeyState;
    });
}

async function encryptFramePayload(
  plaintext: Uint8Array,
  cryptoKey: CryptoKey,
  additionalData: Uint8Array
): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(FRAME_IV_LENGTH));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: toExactArrayBuffer(additionalData) },
    cryptoKey,
    toExactArrayBuffer(plaintext)
  ));

  const encoded = new Uint8Array(FRAME_MAGIC.length + FRAME_IV_LENGTH + ciphertext.length);
  encoded.set(FRAME_MAGIC, 0);
  encoded.set(iv, FRAME_MAGIC.length);
  encoded.set(ciphertext, FRAME_MAGIC.length + FRAME_IV_LENGTH);
  return encoded.buffer;
}

async function decryptFramePayload(
  encodedFrame: Uint8Array,
  cryptoKey: CryptoKey,
  additionalData: Uint8Array
): Promise<ArrayBuffer> {
  if (encodedFrame.length < MIN_ENCRYPTED_FRAME_LENGTH) {
    throw new Error("Invalid encrypted group-call frame");
  }

  const iv = encodedFrame.slice(FRAME_MAGIC.length, FRAME_MAGIC.length + FRAME_IV_LENGTH);
  const ciphertext = encodedFrame.slice(FRAME_MAGIC.length + FRAME_IV_LENGTH);
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toExactArrayBuffer(iv), additionalData: toExactArrayBuffer(additionalData) },
    cryptoKey,
    toExactArrayBuffer(ciphertext)
  );
}

export async function encryptGroupCallFramePayload(
  plaintext: Uint8Array,
  keyBytes: Uint8Array,
  additionalData: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await importAesKey(keyBytes);
  return new Uint8Array(await encryptFramePayload(plaintext, cryptoKey, additionalData));
}

export async function decryptGroupCallFramePayload(
  encodedFrame: Uint8Array,
  keyBytes: Uint8Array,
  additionalData: Uint8Array
): Promise<Uint8Array> {
  if (!startsWithMagic(encodedFrame)) {
    return Uint8Array.from(encodedFrame);
  }

  const cryptoKey = await importAesKey(keyBytes);
  return new Uint8Array(await decryptFramePayload(encodedFrame, cryptoKey, additionalData));
}

export async function processFrameBuffer(
  frameData: ArrayBuffer,
  runtime: FrameCryptoRuntime
): Promise<ArrayBuffer | null> {
  const data = new Uint8Array(frameData);
  const requireEncryption = runtime.requireEncryption === true;

  if (runtime.direction === "send") {
    const primaryKeyState = runtime.keyStates[0] ?? null;
    const cryptoKey = primaryKeyState
      ? await resolveImportedKey(primaryKeyState)
      : null;
    if (!cryptoKey || !primaryKeyState?.rawKey) {
      // Fail closed: in required mode never transmit an unencrypted frame.
      // Dropping (null) is safe for the media pipeline; emitting plaintext
      // while the UI reports E2EE is not.
      return requireEncryption ? null : frameData;
    }
    return encryptFramePayload(data, cryptoKey, runtime.additionalData);
  }

  if (!startsWithMagic(data)) {
    // Fail closed: in required mode a peer must not be able to downgrade the
    // stream by sending cleartext frames that the decoder would accept.
    return requireEncryption ? null : frameData;
  }

  if (runtime.keyStates.length === 0 || data.length < MIN_ENCRYPTED_FRAME_LENGTH) {
    return null;
  }

  try {
    for (const keyState of runtime.keyStates) {
      const cryptoKey = await resolveImportedKey(keyState);
      if (!cryptoKey || !keyState.rawKey) {
        continue;
      }
      try {
        return await decryptFramePayload(data, cryptoKey, runtime.additionalData);
      } catch {
        continue;
      }
    }
  } catch {
    // Drop corrupted/undecryptable encrypted frames instead of feeding garbage into the decoder.
  }

  return null;
}
