import { describe, expect, it } from "vitest";
import {
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
  JsonObjectSchema,
} from "../common.js";

function nested(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let i = 0; i < depth; i += 1) {
    const next: Record<string, unknown> = {};
    cursor["child"] = next;
    cursor = next;
  }
  return root;
}

describe("JsonObjectSchema bounds", () => {
  it("accepts shallow, modest objects", () => {
    expect(
      JsonObjectSchema.safeParse({ a: 1, b: ["x", "y"], c: { d: true } }).success
    ).toBe(true);
  });

  it("rejects objects nested beyond the depth limit", () => {
    expect(JsonObjectSchema.safeParse(nested(MAX_JSON_DEPTH - 2)).success).toBe(true);
    expect(JsonObjectSchema.safeParse(nested(MAX_JSON_DEPTH + 4)).success).toBe(false);
  });

  it("rejects objects exceeding the node limit", () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_JSON_NODES; i += 1) {
      wide[`k${i}`] = i;
    }
    expect(JsonObjectSchema.safeParse(wide).success).toBe(false);
  });
});
