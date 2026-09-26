import type { FastifyInstance } from "fastify";
import { assertDatabaseReachable, assertRequiredEnv, loadInfraEnvIfPresent } from "./env.js";

export default async function globalSetup() {
  loadInfraEnvIfPresent();

  // Ensure JWT_SECRET is available for config.ts which is loaded at module
  // import time inside buildApp(). Vitest does not forward test.env to the
  // globalSetup process, so we set a fallback here if the host env is absent.
  if (!process.env["JWT_SECRET"] || process.env["JWT_SECRET"].length < 32) {
    process.env["JWT_SECRET"] = "integration-test-jwt-secret-fallback-key-42";
  }

  if (process.env["API_URL"]) {
    return;
  }

  assertRequiredEnv(["DATABASE_URL", "JWT_SECRET"]);
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for local integration test bootstrap");
  }
  await assertDatabaseReachable(databaseUrl);

  if (!process.env["QM_API_TEST_USE_IN_MEMORY_SERVICES"]) {
    process.env["QM_API_TEST_USE_IN_MEMORY_SERVICES"] = "1";
  }
  if (!process.env["QM_API_TEST_AUTH_RATE_LIMIT_MAX"]) {
    process.env["QM_API_TEST_AUTH_RATE_LIMIT_MAX"] = "500";
  }
  if (!process.env["QM_API_TEST_REFRESH_RATE_LIMIT_MAX"]) {
    process.env["QM_API_TEST_REFRESH_RATE_LIMIT_MAX"] = "500";
  }
  // Integration tests register users over HTTP, so public registration must be
  // enabled for the test server. Production defaults to disabled (see
  // AUDIT.md H2); CI sets ALLOW_PUBLIC_REGISTRATION=true explicitly, and this
  // fallback keeps local runs consistent with CI. An explicit value always wins.
  if (!process.env["ALLOW_PUBLIC_REGISTRATION"]) {
    process.env["ALLOW_PUBLIC_REGISTRATION"] = "true";
  }

  await import("../db/migrate.js");

  const { buildApp } = await import("../index.js");
  const { pool } = await import("../db/pool.js");
  const { redis } = await import("../services/redis.js");

  const app: FastifyInstance = await buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve API test server address");
  }

  process.env["API_URL"] = `http://127.0.0.1:${address.port}`;

  return async () => {
    await app.close();
    await pool.end();
    redis.disconnect();
  };
}
