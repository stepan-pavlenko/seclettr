import { describe, expect, it } from "vitest";
import {
  CallMediaEncryptionAnswerSchema,
  CallMediaEncryptionOfferSchema,
  GroupCallMediaEncryptionModeSchema,
  GroupCallMediaKeyAckBodySchema,
  GroupCallMediaKeySignalBodySchema,
} from "../media-encryption.js";

describe("media encryption schemas", () => {
  it("accepts direct-call offer and answer payloads", () => {
    const offer = CallMediaEncryptionOfferSchema.safeParse({
      preferredMode: "frame-v1",
      supportedModes: ["frame-v1", "transport"],
    });
    expect(offer.success).toBe(true);

    const answer = CallMediaEncryptionAnswerSchema.safeParse({
      selectedMode: "transport",
      supportedModes: ["transport"],
    });
    expect(answer.success).toBe(true);
  });

  it("rejects unsupported direct-call mode lists", () => {
    const emptyOffer = CallMediaEncryptionOfferSchema.safeParse({
      preferredMode: "transport",
      supportedModes: [],
    });
    expect(emptyOffer.success).toBe(false);

    const oversizedAnswer = CallMediaEncryptionAnswerSchema.safeParse({
      selectedMode: "transport",
      supportedModes: ["transport", "frame-v1", "transport"],
    });
    expect(oversizedAnswer.success).toBe(false);
  });

  it("accepts group-call media key payload fragments", () => {
    const mediaKey = GroupCallMediaKeySignalBodySchema.safeParse({
      targetDeviceId: crypto.randomUUID(),
      epoch: 1,
      keyId: "media-key-1",
      algorithm: "aes-256-gcm",
      encryptedKey: "ciphertext",
    });
    expect(mediaKey.success).toBe(true);

    const ack = GroupCallMediaKeyAckBodySchema.safeParse({
      targetDeviceId: crypto.randomUUID(),
      epoch: 1,
      keyId: "media-key-1",
    });
    expect(ack.success).toBe(true);
  });

  it("keeps group media mode bounded to known values", () => {
    expect(GroupCallMediaEncryptionModeSchema.safeParse("required").success).toBe(true);
    expect(GroupCallMediaEncryptionModeSchema.safeParse("best-effort").success).toBe(true);
    expect(GroupCallMediaEncryptionModeSchema.safeParse("off").success).toBe(true);
    expect(GroupCallMediaEncryptionModeSchema.safeParse("frame-v2").success).toBe(false);
  });

  it("bounds the encrypted media key envelope length", () => {
    const base = {
      targetDeviceId: crypto.randomUUID(),
      epoch: 1,
      keyId: "media-key-1",
      algorithm: "aes-256-gcm",
    } as const;

    expect(
      GroupCallMediaKeySignalBodySchema.safeParse({
        ...base,
        encryptedKey: "x".repeat(4 * 1024 + 1),
      }).success
    ).toBe(false);

    expect(
      GroupCallMediaKeySignalBodySchema.safeParse({
        ...base,
        encryptedKey: "x".repeat(4 * 1024),
      }).success
    ).toBe(true);
  });
});
