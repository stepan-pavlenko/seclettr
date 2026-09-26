import { describe, expect, it } from "vitest";

// Regression test for the Fastify error-handler encapsulation bug: the custom
// `setErrorHandler` was installed *after* route registration, so errors thrown
// inside plugin scopes bypassed it and were serialized by Fastify's default
// handler — leaking the raw driver message (e.g. Postgres `22P02 invalid input
// syntax for type uuid`) with a 500. See AUDIT.md "Path params are generally
// not UUID-validated".
//
// We assert both properties: malformed input is a 400 (not a 500), and the
// response body never echoes the raw Postgres error text.

const BASE_URL = process.env["API_URL"] ?? "http://127.0.0.1:3301";

async function apiRequest(
  path: string,
  options: RequestInit = {},
  token?: string
): Promise<{ status: number; raw: string; body: unknown }> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && options.body !== null) {
    headers.set("Content-Type", "application/json");
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  const raw = await response.text();
  let body: unknown = {};
  try {
    body = raw.trim().length > 0 ? JSON.parse(raw) : {};
  } catch {
    body = {};
  }
  return { status: response.status, raw, body };
}

async function registerUser(username: string): Promise<string> {
  const fakeKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const fakeSig = "A".repeat(88);
  const res = await apiRequest("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      version: 1,
      username,
      password: "TestPassword123!",
      device: {
        name: "Malformed Param Device",
        identityKeyPublic: fakeKey,
        signingKeyPublic: fakeKey,
        registrationId: Math.floor(Math.random() * 16382) + 1,
        signedPreKey: { id: 1, publicKey: fakeKey, signature: fakeSig },
        oneTimePreKeys: Array.from({ length: 5 }, (_, index) => ({
          id: index + 1,
          publicKey: fakeKey,
        })),
      },
    }),
  });
  expect(res.status).toBe(201);
  return (res.body as { accessToken: string }).accessToken;
}

describe("malformed UUID path params", () => {
  it("returns 400 and does not leak the raw database error", async () => {
    const token = await registerUser(`malformed_param_${Date.now()}`);

    const res = await apiRequest("/plain/groups/not-a-uuid", {}, token);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid request parameter" });
    expect(res.raw).not.toContain("invalid input syntax for type uuid");
    expect(res.raw).not.toContain("22P02");
  });
});
