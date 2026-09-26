import { z } from "zod";

export const WS_PROTOCOL_VERSION = 1 as const;
export const MESSAGE_PROTOCOL_VERSION = 1 as const;
export const SFU_PROTOCOL_VERSION = 1 as const;
export const AUTH_PROTOCOL_VERSION = 1 as const;
export const DEVICES_PROTOCOL_VERSION = 1 as const;
export const GROUPS_PROTOCOL_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = Record<string, unknown>;

/**
 * Upper bounds for free-form JSON carried over the wire. Without them a peer
 * can send a deeply nested or node-heavy object that expands during parsing and
 * downstream traversal (see AUDIT.md H15).
 */
export const MAX_JSON_DEPTH = 32;
export const MAX_JSON_NODES = 10_000;

function isBoundedJson(value: unknown): boolean {
  let nodes = 0;
  const stack: Array<{ value: unknown; depth: number }> = [
    { value, depth: 1 },
  ];

  while (stack.length > 0) {
    const { value: current, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      return false;
    }
    if (current === null || typeof current !== "object") {
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) {
        stack.push({ value: item, depth: depth + 1 });
      }
      continue;
    }
    for (const item of Object.values(current)) {
      stack.push({ value: item, depth: depth + 1 });
    }
  }

  return true;
}

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ])
);

// `z.preprocess` (not `.refine`) is used deliberately: the depth/node check
// must run BEFORE the recursive `JsonValueSchema` walk, otherwise a deeply
// nested payload could overflow the stack during parsing itself. When the
// bound is violated the value is replaced with a sentinel that the inner
// record schema rejects, without recursing into the original input.
const UNBOUNDED_JSON_SENTINEL = Symbol("unbounded-json");

export const JsonObjectSchema: z.ZodType<JsonObject, z.ZodTypeDef, unknown> =
  z.preprocess(
    (value) => (isBoundedJson(value) ? value : UNBOUNDED_JSON_SENTINEL),
    z.record(JsonValueSchema)
  );

export type StripVersion<T> = T extends { version: unknown }
  ? Omit<T, "version">
  : T;

export type VersionedWireErrorCode =
  | "INVALID_PAYLOAD"
  | "UNSUPPORTED_PROTOCOL_VERSION";

export interface VersionedWireParseError {
  code: VersionedWireErrorCode;
  supportedVersion: number;
  receivedVersion?: number | null;
  details?: unknown;
}

export type VersionedWireParseResult<T> =
  | {
      success: true;
      data: StripVersion<T>;
      wireData: T;
    }
  | {
      success: false;
      error: VersionedWireParseError;
    };

export function wireObject<TShape extends z.ZodRawShape>(shape: TShape) {
  return z.object(shape).strict();
}

export function versionedWireObject<TShape extends z.ZodRawShape>(
  version: number,
  shape: TShape
) {
  return wireObject({
    version: z.literal(version),
    ...shape,
  });
}

export function withWireVersion<T extends object, TVersion extends number>(
  payload: T,
  version: TVersion
): T & { version: TVersion } {
  const normalized =
    "version" in payload
      ? (() => {
          const { version: _ignored, ...rest } = payload as T & {
            version?: unknown;
          };
          return rest;
        })()
      : payload;
  return {
    version,
    ...normalized,
  } as T & { version: TVersion };
}

export function safeParseVersionedWire<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  payload: unknown,
  supportedVersion: number
): VersionedWireParseResult<z.infer<TSchema>> {
  const receivedVersion = extractWireVersion(payload);
  if (
    typeof receivedVersion === "number" &&
    Number.isInteger(receivedVersion) &&
    receivedVersion !== supportedVersion
  ) {
    return {
      success: false,
      error: {
        code: "UNSUPPORTED_PROTOCOL_VERSION",
        supportedVersion,
        receivedVersion,
      },
    };
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return {
      success: false,
      error: {
        code: "INVALID_PAYLOAD",
        supportedVersion,
        receivedVersion,
        details: parsed.error.flatten(),
      },
    };
  }

  return {
    success: true,
    data: stripWireVersion(parsed.data),
    wireData: parsed.data,
  };
}

function extractWireVersion(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const candidate = (payload as { version?: unknown }).version;
  return typeof candidate === "number" ? candidate : null;
}

function stripWireVersion<T>(value: T): StripVersion<T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value as StripVersion<T>;
  }

  const { version: _ignored, ...rest } = value as T & {
    version?: unknown;
  };
  return rest as StripVersion<T>;
}
