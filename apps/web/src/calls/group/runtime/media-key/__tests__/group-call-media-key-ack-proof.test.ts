import { describe, expect, it } from "vitest";
import {
  computeMediaKeyAckProof,
  verifyMediaKeyAckProof,
} from "@/calls/group/runtime/media-key/media-key-ack-proof";

describe("media-key-ack-proof", () => {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));

  it("accepts a proof computed with the matching key", async () => {
    const proof = await computeMediaKeyAckProof(rawKey, "key-1", 3);
    await expect(
      verifyMediaKeyAckProof(rawKey, "key-1", 3, proof)
    ).resolves.toBe(true);
  });

  it("rejects a proof computed with a different key", async () => {
    const otherKey = crypto.getRandomValues(new Uint8Array(32));
    const proof = await computeMediaKeyAckProof(otherKey, "key-1", 3);
    await expect(
      verifyMediaKeyAckProof(rawKey, "key-1", 3, proof)
    ).resolves.toBe(false);
  });

  it("rejects a proof bound to a different epoch", async () => {
    const proof = await computeMediaKeyAckProof(rawKey, "key-1", 3);
    await expect(
      verifyMediaKeyAckProof(rawKey, "key-1", 4, proof)
    ).resolves.toBe(false);
  });

  it("rejects a missing proof (fail closed)", async () => {
    await expect(
      verifyMediaKeyAckProof(rawKey, "key-1", 3, undefined)
    ).resolves.toBe(false);
  });
});
