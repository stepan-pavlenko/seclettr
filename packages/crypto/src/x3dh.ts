import { ensureSodium } from "./sodium.js";
import { type KeyPair, type PreKeyPair } from "./keys.js";
import { buf } from "./buf.js";
import {
  initReceiver,
  ratchetDecrypt,
  type EncryptedMessage,
  type RatchetState,
} from "./double-ratchet.js";

const X3DH_INFO = "Seclettr X3DH v1";
const X3DH_SALT = new Uint8Array(32);

export interface PreKeyBundle {
  registrationId: number;
  identityKey: Uint8Array;
  signingKey: Uint8Array;
  signedPreKey: { id: number; publicKey: Uint8Array; signature: Uint8Array };
  oneTimePreKey?: { id: number; publicKey: Uint8Array };
}

export interface X3DHInitMessage {
  ephemeralKey: Uint8Array;
  signedPreKeyId: number;
  oneTimePreKeyId?: number;
  ciphertext: Uint8Array;
}

export interface X3DHResult {
  sharedSecret: Uint8Array;
  associatedData: Uint8Array;
}

export interface ReceiverBootstrapParams {
  receiverIdentityKeyPair: KeyPair;
  receiverSignedPreKeyPair: PreKeyPair;
  receiverOneTimePreKeyPair?: PreKeyPair;
  senderIdentityPublicKey: Uint8Array;
  senderEphemeralPublicKey: Uint8Array;
  initialMessage: EncryptedMessage;
  associatedData: Uint8Array;
}

export interface ReceiverBootstrapResult {
  session: RatchetState;
  plaintext: Uint8Array;
  consumedOneTimePreKeyId?: number;
}

async function hkdf(
  inputKeyMaterial: Uint8Array,
  salt: Uint8Array,
  info: string,
  length: number
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    buf(inputKeyMaterial),
    { name: "HKDF" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: buf(salt),
      info: enc.encode(info),
    },
    baseKey,
    length * 8
  );
  return new Uint8Array(bits);
}

async function dh(myPrivate: Uint8Array, theirPublic: Uint8Array): Promise<Uint8Array> {
  const sodium = await ensureSodium();
  return sodium.crypto_scalarmult(myPrivate, theirPublic);
}

export async function x3dhSend(
  senderIdentityKeyPair: KeyPair,
  senderEphemeralKeyPair: KeyPair,
  bundle: PreKeyBundle
): Promise<X3DHResult> {
  const sodium = await ensureSodium();

  const valid = sodium.crypto_sign_verify_detached(
    bundle.signedPreKey.signature,
    bundle.signedPreKey.publicKey,
    bundle.signingKey
  );
  if (!valid) throw new Error("Invalid signed prekey signature");

  const dh1 = await dh(senderIdentityKeyPair.privateKey, bundle.signedPreKey.publicKey);
  const dh2 = await dh(senderEphemeralKeyPair.privateKey, bundle.identityKey);
  const dh3 = await dh(senderEphemeralKeyPair.privateKey, bundle.signedPreKey.publicKey);

  let dhInput: Uint8Array;
  if (bundle.oneTimePreKey) {
    const dh4 = await dh(senderEphemeralKeyPair.privateKey, bundle.oneTimePreKey.publicKey);
    dhInput = concat(dh1, dh2, dh3, dh4);
    dh4.fill(0);
  } else {
    dhInput = concat(dh1, dh2, dh3);
  }

  const sharedSecret = await hkdf(dhInput, X3DH_SALT, X3DH_INFO, 32);

  const associatedData = concat(
    senderIdentityKeyPair.publicKey,
    bundle.identityKey
  );

  dh1.fill(0);
  dh2.fill(0);
  dh3.fill(0);
  dhInput.fill(0);

  return { sharedSecret, associatedData };
}

export async function x3dhReceive(
  receiverIdentityKeyPair: KeyPair,
  receiverSignedPreKeyPair: PreKeyPair,
  receiverOneTimePreKeyPair: PreKeyPair | undefined,
  senderIdentityPublicKey: Uint8Array,
  senderEphemeralPublicKey: Uint8Array
): Promise<X3DHResult> {
  const dh1 = await dh(receiverSignedPreKeyPair.privateKey, senderIdentityPublicKey);
  const dh2 = await dh(receiverIdentityKeyPair.privateKey, senderEphemeralPublicKey);
  const dh3 = await dh(receiverSignedPreKeyPair.privateKey, senderEphemeralPublicKey);

  let dhInput: Uint8Array;
  if (receiverOneTimePreKeyPair) {
    const dh4 = await dh(receiverOneTimePreKeyPair.privateKey, senderEphemeralPublicKey);
    dhInput = concat(dh1, dh2, dh3, dh4);
    dh4.fill(0);
  } else {
    dhInput = concat(dh1, dh2, dh3);
  }

  const sharedSecret = await hkdf(dhInput, X3DH_SALT, X3DH_INFO, 32);

  const associatedData = concat(senderIdentityPublicKey, receiverIdentityKeyPair.publicKey);

  dh1.fill(0);
  dh2.fill(0);
  dh3.fill(0);
  dhInput.fill(0);

  return { sharedSecret, associatedData };
}

export async function bootstrapReceiverSession(
  params: ReceiverBootstrapParams
): Promise<ReceiverBootstrapResult> {
  const { sharedSecret } = await x3dhReceive(
    params.receiverIdentityKeyPair,
    params.receiverSignedPreKeyPair,
    params.receiverOneTimePreKeyPair,
    params.senderIdentityPublicKey,
    params.senderEphemeralPublicKey
  );

  try {
    const session = await initReceiver(sharedSecret, params.receiverSignedPreKeyPair);
    const plaintext = await ratchetDecrypt(
      session,
      params.initialMessage,
      params.associatedData
    );
    const consumedOneTimePreKeyId = params.receiverOneTimePreKeyPair?.id;

    if (consumedOneTimePreKeyId === undefined) {
      return {
        session,
        plaintext,
      };
    }

    return {
      session,
      plaintext,
      consumedOneTimePreKeyId,
    };
  } finally {
    sharedSecret.fill(0);
  }
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}
