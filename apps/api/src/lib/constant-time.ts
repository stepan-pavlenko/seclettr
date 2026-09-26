import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison for secrets (AUDIT.md Medium: `/metrics`
 * bearer comparison). Both inputs are hashed to a fixed 32-byte digest first,
 * so the comparison does not leak the expected secret's length. Returns false
 * on any length-independent mismatch (including empty/undefined input).
 */
export function constantTimeEqualString(
  actual: string | undefined,
  expected: string | undefined
): boolean {
  if (typeof actual !== "string" || typeof expected !== "string") {
    return false;
  }
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}