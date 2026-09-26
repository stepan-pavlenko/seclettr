/**
 * @ownedBy auth-runtime / HTTP transport
 *
 * Core HTTP client — shared by all lib/api/* domain modules.
 * Owns the sole `accessToken` state for the page lifetime.
 * Exports: request(), setAccessToken(), getAccessToken(), ApiError,
 * parseVersionedApiPayload(), parseLocalPayload(), sendBestEffortKeepalive().
 * Domain modules import these helpers directly; all public exports are
 * re-exported through lib/api/index.ts for consumer backward-compat.
 *
 * Pre-existing cycle (safe in ESM):
 *   client.ts → session.ts → lib/api (index.ts) → client.ts
 * Both call sites are lazy (invoked only on 401 retry / post-refresh).
 */
import { safeParseVersionedWire } from "@seclettr/protocol";
import { z, type ZodTypeAny } from "zod";
import { refreshSessionAccessToken } from "../session";
import { resolveApiBaseUrl } from "../runtime-config";
import { isNativePlatform, getNativeServerUrl } from "../native-platform";

let accessToken: string | null = null;

// Metadata requests (JSON in/out, no large bodies) should not hang forever.
// 30s is well above normal API latency and far below the browser's own limits;
// uploads do not flow through this path (see upload-progress.ts).
const REQUEST_TIMEOUT_MS = 30_000;

function buildRequestHeaders(options: RequestInit = {}): Headers {
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type") && options.body !== undefined && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (accessToken) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }
  // Browser strips Origin/Referer for same-origin GET (and we set
  // referrer-policy=no-referrer globally), so the API can't recover the
  // browser-facing origin from standard headers when rewriting presigned S3
  // URLs. We pass it explicitly so the rewritten URL matches the page origin
  // and the browser trusts the cert / honors CORS.
  //
  // On Capacitor, location.origin is always `https://localhost` — use the
  // stored server URL's origin instead so presigned S3 URLs are rewritten to
  // the real public server (which Nginx proxies to MinIO), not to localhost.
  let clientOrigin: string | null = null;
  if (isNativePlatform()) {
    const serverUrl = getNativeServerUrl();
    if (serverUrl) {
      try { clientOrigin = new URL(serverUrl).origin; } catch { /* ignore malformed */ }
    }
  } else if (typeof globalThis.location !== "undefined" && globalThis.location.origin) {
    clientOrigin = globalThis.location.origin;
  }
  if (clientOrigin) {
    headers.set("X-Client-Origin", clientOrigin);
  }
  return headers;
}

export function sendBestEffortKeepalive(path: string, options: RequestInit = {}): void {
  const headers = buildRequestHeaders(options);
  fetch(`${resolveApiBaseUrl()}${path}`, {
    ...options,
    headers,
    credentials: "include",
    keepalive: true,
  }).catch(() => {
    // Best-effort unload cleanup.
  });
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
  retry = true
): Promise<T> {
  const headers = buildRequestHeaders(options);

  // Bound how long a metadata request can hang. Uploads/large transfers use
  // their own XHR/fetch paths (upload-progress.ts), so a blanket timeout here
  // cannot truncate them. A caller-provided signal is preserved and composed
  // with our timeout so both can abort the request.
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  let res: Response;
  try {
    res = await fetch(`${resolveApiBaseUrl()}${path}`, {
      ...options,
      headers,
      credentials: "include",
      signal,
    });
  } catch (err) {
    if (timeoutSignal.aborted && !options.signal?.aborted) {
      throw new ApiError(408, "Request timed out");
    }
    throw err;
  }

  if (res.status === 401 && retry && !path.startsWith("/auth/")) {
    // refreshSessionAccessToken() deduplicates concurrent calls across HTTP, WS,
    // and SFU transports — safe to await without a local wrapper.
    // Auth endpoints (/auth/login, /auth/register, …) are exempt — their 401
    // means "invalid credentials", not "session expired", and the response body
    // carries the real error message which the generic handler below will read.
    const newToken = await refreshSessionAccessToken();
    if (newToken) {
      return request<T>(path, options, false);
    }
    // Refresh failed — clear auth state
    accessToken = null;
    throw new ApiError(401, "Session expired");
  }

  if (!res.ok) {
    let message = "Request failed";
    try {
      const body = await res.text();
      if (body.trim().length > 0) {
        try {
          const err = JSON.parse(body) as { error?: string };
          message = err.error ?? body;
        } catch {
          message = body;
        }
      }
    } catch { /* ignore */ }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204 || res.status === 205) {
    return undefined as T;
  }

  const body = await res.text();
  if (body.trim().length === 0) {
    return undefined as T;
  }

  return JSON.parse(body) as T;
}

export function parseVersionedApiPayload<TSchema extends ZodTypeAny>(
  schema: TSchema,
  payload: unknown,
  supportedVersion: number
) {
  const parsed = safeParseVersionedWire(
    schema,
    payload,
    supportedVersion
  );
  if (!parsed.success) {
    throw new Error(
      parsed.error.code === "UNSUPPORTED_PROTOCOL_VERSION"
        ? `Unsupported API protocol version ${String(parsed.error.receivedVersion ?? "unknown")}`
        : "Invalid API payload"
    );
  }
  return parsed.data;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export function parseLocalPayload<TSchema extends ZodTypeAny>(
  schema: TSchema,
  payload: unknown
): z.infer<TSchema> {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new Error("Invalid API payload");
  }
  return result.data as z.infer<TSchema>;
}
