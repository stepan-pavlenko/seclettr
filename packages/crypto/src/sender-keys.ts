import { ensureSodium } from "./sodium.js";
import { aeadEncrypt, aeadDecrypt } from "./double-ratchet.js";
import { buf } from "./buf.js";

const MAX_SENDER_KEY_SKIP = 1000;

export interface SenderKeyState {
  chainKey: Uint8Array;
  chainId: number;
  signingPublicKey: Uint8Array;
  signingPrivateKey?: Uint8Array;
  /** Skipped message keys: `${distributionId}:${messageId}` → message key */
  MKSKIPPED: Map<string, Uint8Array>;
}

export interface SenderKeyDistributionMessage {
  distributionId: string;
  chainId: number;
  chainKey: Uint8Array;
  signingKey: Uint8Array;
}

export interface SenderKeyMessage {
  distributionId: string;
  chainId: number;
  messageId: number;
  ciphertext: Uint8Array;
  signature: Uint8Array;
  /** 0 = legacy empty AEAD AD; 1 = distributionId+chainId+messageId AD */
  aeadVersion: 0 | 1;
}

export interface SerializedSenderKeyState {
  chainKey: string;     // base64url
  chainId: number;
  signingPublicKey: string;  // base64url
  signingPrivateKey?: string; // base64url
  MKSKIPPED: Array<[string, string]>; // [key, base64url value]
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", k, buf(data));
  return new Uint8Array(sig);
}

async function advanceChainKey(ck: Uint8Array): Promise<{ nextCk: Uint8Array; mk: Uint8Array }> {
  const nextCk = await hmacSha256(ck, new Uint8Array([0x01]));
  const mk = await hmacSha256(ck, new Uint8Array([0x02]));
  return { nextCk, mk };
}

function buildAeadAd(
  distributionId: string,
  chainId: number,
  messageId: number
): Uint8Array {
  const enc = new TextEncoder();
  const id = enc.encode(distributionId);
  const out = new Uint8Array(id.length + 8);
  out.set(id, 0);
  new DataView(out.buffer).setUint32(id.length, chainId, false);
  new DataView(out.buffer).setUint32(id.length + 4, messageId, false);
  return out;
}

export async function generateSenderKey(): Promise<SenderKeyState> {
  const sodium = await ensureSodium();
  const chainKey = sodium.randombytes_buf(32);
  const sigKP = sodium.crypto_sign_keypair();
  return {
    chainKey,
    chainId: 0,
    signingPublicKey: sigKP.publicKey,
    signingPrivateKey: sigKP.privateKey,
    MKSKIPPED: new Map(),
  };
}

export async function senderKeyEncrypt(
  state: SenderKeyState,
  distributionId: string,
  plaintext: Uint8Array
): Promise<{ message: SenderKeyMessage; newState: SenderKeyState }> {
  if (!state.signingPrivateKey) throw new Error("Cannot encrypt: no signing private key");
  const sodium = await ensureSodium();

  const { nextCk, mk } = await advanceChainKey(state.chainKey);
  const messageId = state.chainId;

  const ad = buildAeadAd(distributionId, state.chainId, messageId);
  const ciphertext = await aeadEncrypt(mk, plaintext, ad);
  mk.fill(0);

  const sigData = buildSignData(distributionId, state.chainId, messageId, ciphertext);
  const signature = sodium.crypto_sign_detached(sigData, state.signingPrivateKey);

  const newState: SenderKeyState = {
    chainKey: nextCk,
    chainId: state.chainId + 1,
    signingPublicKey: state.signingPublicKey,
    ...(state.signingPrivateKey !== undefined && { signingPrivateKey: state.signingPrivateKey }),
    MKSKIPPED: state.MKSKIPPED,
  };

  return {
    message: { distributionId, chainId: state.chainId, messageId, ciphertext, signature, aeadVersion: 1 },
    newState,
  };
}

export async function senderKeyDecrypt(
  state: SenderKeyState,
  message: SenderKeyMessage
): Promise<{ plaintext: Uint8Array; newState: SenderKeyState }> {
  const sodium = await ensureSodium();

  if (!Number.isSafeInteger(message.messageId) || message.messageId < 0) {
    throw new Error("Invalid sender key message ID");
  }

  const sigData = buildSignData(
    message.distributionId, message.chainId, message.messageId, message.ciphertext
  );
  const valid = sodium.crypto_sign_verify_detached(message.signature, sigData, state.signingPublicKey);
  if (!valid) throw new Error("Invalid group message signature");

  const aeadVersion = message.aeadVersion ?? 0;
  const ad = aeadVersion === 0
    ? new Uint8Array(0)
    : buildAeadAd(message.distributionId, message.chainId, message.messageId);
  const skipKey = `${message.distributionId}:${message.messageId}`;

  // Fast path: message arrived out-of-order but its key was cached earlier.
  const cachedMk = state.MKSKIPPED.get(skipKey);
  if (cachedMk) {
    // `cachedMk` is owned by the caller's state.MKSKIPPED. Decrypt with a
    // clone and zero the clone instead of mutating the caller's buffer —
    // `cachedMk.fill(0)` would corrupt the caller's retained state (AUDIT.md H14).
    const mk = Uint8Array.from(cachedMk);
    const newSkipped = new Map(state.MKSKIPPED);
    newSkipped.delete(skipKey);
    try {
      const plaintext = await aeadDecrypt(mk, message.ciphertext, ad);
      return {
        plaintext,
        newState: { ...state, MKSKIPPED: newSkipped },
      };
    } finally {
      mk.fill(0);
    }
  }

  const gap = message.messageId - state.chainId;

  if (gap < 0) {
    throw new Error("Sender key message already processed");
  }
  if (gap + state.MKSKIPPED.size > MAX_SENDER_KEY_SKIP) {
    throw new Error("Too many skipped sender key messages");
  }

  // Advance the chain, caching keys for skipped messages.
  let ck = state.chainKey;
  let chainId = state.chainId;
  const newSkipped = new Map(state.MKSKIPPED);
  let mk: Uint8Array | null = null;

  while (chainId <= message.messageId) {
    const adv = await advanceChainKey(ck);
    if (chainId === message.messageId) {
      mk = adv.mk;
    } else {
      // Cache skipped key for potential out-of-order delivery later.
      newSkipped.set(`${message.distributionId}:${chainId}`, adv.mk);
    }
    ck = adv.nextCk;
    chainId++;
  }

  if (!mk) throw new Error("Message ID mismatch");

  let plaintext;
  try {
    plaintext = await aeadDecrypt(mk, message.ciphertext, ad);
  } finally {
    mk.fill(0);
  }

  return {
    plaintext,
    newState: {
      chainKey: ck,
      chainId,
      signingPublicKey: state.signingPublicKey,
      ...(state.signingPrivateKey !== undefined && { signingPrivateKey: state.signingPrivateKey }),
      MKSKIPPED: newSkipped,
    },
  };
}

function buildSignData(
  distributionId: string,
  chainId: number,
  messageId: number,
  ciphertext: Uint8Array
): Uint8Array {
  const enc = new TextEncoder();
  const id = enc.encode(distributionId);
  const out = new Uint8Array(id.length + 4 + 4 + ciphertext.length);
  out.set(id, 0);
  new DataView(out.buffer).setUint32(id.length, chainId, false);
  new DataView(out.buffer).setUint32(id.length + 4, messageId, false);
  out.set(ciphertext, id.length + 8);
  return out;
}

export function serializeSenderKeyState(state: SenderKeyState): SerializedSenderKeyState {
  const b64 = (b: Uint8Array) =>
    btoa(String.fromCodePoint(...b)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return {
    chainKey: b64(state.chainKey),
    chainId: state.chainId,
    signingPublicKey: b64(state.signingPublicKey),
    ...(state.signingPrivateKey !== undefined && { signingPrivateKey: b64(state.signingPrivateKey) }),
    MKSKIPPED: Array.from(state.MKSKIPPED.entries()).map(([k, v]) => [k, b64(v)]),
  };
}

export function deserializeSenderKeyState(s: SerializedSenderKeyState): SenderKeyState {
  const fromB64 = (str: string): Uint8Array => {
    const padded = str.replaceAll("-", "+").replaceAll("_", "/");
    const pad = (4 - (padded.length % 4)) % 4;
    const raw = atob(padded + "=".repeat(pad));
    return Uint8Array.from(raw, (c) => c.codePointAt(0)!);
  };
  const mkskipped = new Map<string, Uint8Array>();
  for (const [k, v] of (s.MKSKIPPED ?? [])) {
    mkskipped.set(k, fromB64(v));
  }
  return {
    chainKey: fromB64(s.chainKey),
    chainId: s.chainId,
    signingPublicKey: fromB64(s.signingPublicKey),
    ...(s.signingPrivateKey !== undefined && { signingPrivateKey: fromB64(s.signingPrivateKey) }),
    MKSKIPPED: mkskipped,
  };
}

export { MAX_SENDER_KEY_SKIP };
