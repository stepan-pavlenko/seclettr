import { describe, expect, it } from "vitest";
import { sanitizeLogValue } from "@/lib/logger";

describe("sanitizeLogValue depth bounding", () => {
  it("redacts sensitive keys", () => {
    const out = sanitizeLogValue({
      token: "abc",
      authorization: "Bearer xyz",
      safe: "ok",
    }) as Record<string, unknown>;
    expect(out["token"]).toBe("[REDACTED]");
    expect(out["authorization"]).toBe("[REDACTED]");
    expect(out["safe"]).toBe("ok");
  });

  it("does not return raw values beyond the max depth", () => {
    // depth > MAX_SANITIZE_DEPTH must be replaced, not passed through.
    const deep = { nested: { token: "super-secret-token" } };
    const out = sanitizeLogValue(deep, 3);
    expect(out).toBe("[Truncated]");
    expect(JSON.stringify(out)).not.toContain("super-secret-token");
  });

  it("still sanitizes values within the depth bound", () => {
    const out = sanitizeLogValue(
      { nested: { token: "super-secret-token" } },
      1
    ) as Record<string, unknown>;
    expect(out["nested"]).toEqual({ token: "[REDACTED]" });
  });

  it("redacts JWT-shaped strings", () => {
    const jwt = "aaa.bbb.ccc";
    expect(sanitizeLogValue(jwt, 0)).toBe(jwt);
    const long =
      "aaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccccccccccccccccccccc";
    expect(sanitizeLogValue(long, 0)).toBe("[REDACTED_JWT]");
  });
});