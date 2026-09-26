import { z } from "zod";

export const CallMediaEncryptionModeSchema = z.enum(["transport", "frame-v1"]);
export type CallMediaEncryptionMode = z.infer<typeof CallMediaEncryptionModeSchema>;

export const CallMediaSourceSchema = z.enum(["camera", "screen", "mic"]);
export type CallMediaSource = z.infer<typeof CallMediaSourceSchema>;

export const CallMediaStateSchema = z.enum(["on", "off", "muted", "ended"]);
export type CallMediaState = z.infer<typeof CallMediaStateSchema>;

export const CallMediaActivitySchema = z.enum(["active", "inactive"]);
export type CallMediaActivity = z.infer<typeof CallMediaActivitySchema>;

export const CallMediaStateReasonSchema = z.enum([
  "user-toggle",
  "permission-denied",
  "track-ended",
  "replace-track",
  "cleanup",
]);
export type CallMediaStateReason = z.infer<typeof CallMediaStateReasonSchema>;

const MAX_EPHEMERAL_KEY_B64_LENGTH = 64;

/**
 * A sealed media-key envelope contains a short versioned JSON payload
 * (call/device ids, epoch, keyId, algorithm, base64url AES key) wrapped in a
 * libsodium sealed box — a few hundred bytes, so base64url is under ~1 KiB.
 * Bound it so a peer cannot inflate the signal (AUDIT.md H15).
 */
const MAX_ENCRYPTED_KEY_LENGTH = 4 * 1024;

export const CallMediaEncryptionOfferSchema = z.object({
  preferredMode: CallMediaEncryptionModeSchema,
  supportedModes: z.array(CallMediaEncryptionModeSchema).min(1).max(2),
  // X25519 ephemeral public key (base64url, 32 bytes → 43 chars). Present when
  // the sender supports per-call forward secrecy (frame-v2 derivation).
  ephemeralPublicKey: z.string().max(MAX_EPHEMERAL_KEY_B64_LENGTH).optional(),
});
export type CallMediaEncryptionOffer = z.infer<typeof CallMediaEncryptionOfferSchema>;

export const CallMediaEncryptionAnswerSchema = z.object({
  selectedMode: CallMediaEncryptionModeSchema,
  supportedModes: z.array(CallMediaEncryptionModeSchema).min(1).max(2),
  ephemeralPublicKey: z.string().max(MAX_EPHEMERAL_KEY_B64_LENGTH).optional(),
});
export type CallMediaEncryptionAnswer = z.infer<typeof CallMediaEncryptionAnswerSchema>;

export const DirectCallFeaturesSchema = z.object({
  renegotiationV1: z.literal(true),
});
export type DirectCallFeatures = z.infer<typeof DirectCallFeaturesSchema>;

export const GroupCallMediaEncryptionModeSchema = z.enum(["off", "best-effort", "required"]);
export type GroupCallMediaEncryptionMode = z.infer<typeof GroupCallMediaEncryptionModeSchema>;

export const GroupCallMediaKeyAlgorithmSchema = z.literal("aes-256-gcm");
export type GroupCallMediaKeyAlgorithm = z.infer<typeof GroupCallMediaKeyAlgorithmSchema>;

export const GroupCallMediaKeySignalBodySchema = z.object({
  targetDeviceId: z.string().uuid(),
  epoch: z.number().int().min(1).max(1_000_000),
  keyId: z.string().min(1).max(128),
  algorithm: GroupCallMediaKeyAlgorithmSchema,
  encryptedKey: z.string().min(1).max(MAX_ENCRYPTED_KEY_LENGTH),
});
export type GroupCallMediaKeySignalBody = z.infer<typeof GroupCallMediaKeySignalBodySchema>;

export const GroupCallMediaKeyAckBodySchema = z.object({
  targetDeviceId: z.string().uuid(),
  epoch: z.number().int().min(1).max(1_000_000),
  keyId: z.string().min(1).max(128),
  /** HMAC-SHA-256 of the raw AES key, keyed by the keyId (UTF-8), base64url-encoded.
   *  Optional for backward compatibility with older clients. */
  keyProof: z.string().min(1).max(64).optional(),
});
export type GroupCallMediaKeyAckBody = z.infer<typeof GroupCallMediaKeyAckBodySchema>;
