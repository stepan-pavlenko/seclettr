import { describe, expect, it } from "vitest";
import { constantTimeEqualString } from "../lib/constant-time.js";

describe("constantTimeEqualString", () => {
  it("matches identical strings", () => {
    expect(constantTimeEqualString("Bearer abc123", "Bearer abc123")).toBe(true);
  });

  it("rejects different strings", () => {
    expect(constantTimeEqualString("Bearer abc123", "Bearer abc124")).toBe(false);
  });

  it("rejects differing lengths", () => {
    expect(constantTimeEqualString("Bearer abc123", "Bearer abc1234")).toBe(false);
  });

  it("rejects empty and undefined inputs", () => {
    expect(constantTimeEqualString("", "")).toBe(true);
    expect(constantTimeEqualString(undefined, "Bearer x")).toBe(false);
    expect(constantTimeEqualString("Bearer x", undefined)).toBe(false);
  });
});