/**
 * Seclettr API Server entry point.
 *
 * Security headers, rate limiting, CORS, and all routes are registered here.
 */
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyJwt from "@fastify/jwt";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyWebsocket from "@fastify/websocket";
import fastifyMultipart from "@fastify/multipart";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { WS_CLIENT_PROTOCOL } from "@seclettr/protocol";

import { config } from "./config.js";
import { APP_VERSION } from "./version.js";
import { isCapacitorOriginAllowed, isDevelopmentCorsOriginAllowed } from "./cors.js";
import { pool, query } from "./db/pool.js";
import { redis, usingInMemoryRedis } from "./services/redis.js";
import { registerWebSocketHandler } from "./services/websocket.js";
import {
  cacheDepHealth,
  getCachedDepHealth,
  recordHttpResponse,
  renderPrometheusMetrics,
} from "./services/observability.js";

import { runRetentionCleanup } from "./services/retention.js";
import { authRoutes } from "./routes/auth/index.js";
import { deviceRoutes, userRoutes } from "./routes/devices/index.js";
import { messageRoutes, groupMessageRoutes } from "./routes/messages/index.js";
import { groupRoutes } from "./routes/groups/index.js";
import { attachmentRoutes } from "./routes/attachments/index.js";
import { callRoutes } from "./routes/calls/index.js";
import { roomRoutes } from "./routes/rooms/index.js";
import { pushRoutes } from "./routes/push/index.js";
import { clientErrorRoutes } from "./routes/client-errors/index.js";
import { transferRoutes } from "./routes/transfer/index.js";
import { plainConversationRoutes } from "./routes/plain/conversations.js";
import { plainMessageRoutes } from "./routes/plain/messages.js";
import { plainGroupRoutes } from "./routes/plain/groups.js";
import { plainAttachmentRoutes } from "./routes/plain/attachments.js";
import { plainPinRoutes } from "./routes/plain/pins.js";
import { plainFolderRoutes } from "./routes/plain/folders.js";
import { profileRoutes } from "./routes/profile/index.js";
import { constantTimeEqualString } from "./lib/constant-time.js";

const LEGACY_WS_CLIENT_PROTOCOL = "qm.v1";

function isMetricsAuthorized(authorization: string | undefined): boolean {
  if (!config.METRICS_BEARER_TOKEN) {
    return false;
  }
  return constantTimeEqualString(
    authorization,
    `Bearer ${config.METRICS_BEARER_TOKEN}`
  );
}

function selectWsClientProtocol(protocols: Set<string>): string | false {
  if (protocols.has(WS_CLIENT_PROTOCOL)) {
    return WS_CLIENT_PROTOCOL;
  }
  if (protocols.has(LEGACY_WS_CLIENT_PROTOCOL)) {
    return LEGACY_WS_CLIENT_PROTOCOL;
  }
  return false;
}

function stripQuery(url: string): string {
  const qIndex = url.indexOf("?");
  return qIndex >= 0 ? url.slice(0, qIndex) : url;
}

export async function buildApp() {
  const fastify = Fastify({
    logger: {
      level: config.NODE_ENV === "production" ? "warn" : "info",
      // Never log request bodies (may contain sensitive data)
      serializers: {
        req(req) {
          return {
            method: req.method,
            url: stripQuery(req.url ?? ""),
            hostname: req.hostname,
          };
        },
      },
    },
    trustProxy: config.TRUST_PROXY,
    onProtoPoisoning: "error",
    onConstructorPoisoning: "error",
  });

  fastify.addHook("onSend", async (request, reply, payload) => {
    if (!reply.hasHeader("x-request-id")) {
      reply.header("X-Request-ID", request.id);
    }
    return payload;
  });

  fastify.addHook("onRequest", async (request, reply) => {
    const contentType = request.headers["content-type"];
    if (typeof contentType === "string" && /[\t\r\n]/.test(contentType)) {
      return reply.code(400).send({ error: "Invalid Content-Type header" });
    }
  });

  fastify.addHook("onResponse", async (_request, reply) => {
    recordHttpResponse(reply.statusCode);
  });

  // CSP is managed by Nginx to avoid double-header conflicts; Helmet covers the rest.
  await fastify.register(fastifyHelmet, {
    contentSecurityPolicy: false,
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  });

  const allowedOrigins = config.CORS_ORIGIN.split(",").map(o => o.trim());
  await fastify.register(fastifyCors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (isCapacitorOriginAllowed(origin)) {
        return cb(null, true);
      }
      if (config.NODE_ENV === "development") {
        return cb(null, isDevelopmentCorsOriginAllowed(origin, allowedOrigins));
      }
      cb(null, allowedOrigins.includes(origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Request-ID", "X-Client-Origin", "X-Refresh-Token"],
  });

  await fastify.register(fastifyRateLimit, {
    global: true,
    max: 200,
    timeWindow: "1 minute",
    // Do not take the API down when Redis is unavailable: fail open like the
    // per-route fixed-window limiter instead of returning 500 for every request.
    skipOnError: true,
    ...(usingInMemoryRedis ? {} : { redis }),
    keyGenerator: (request) =>
      `${request.ip}:${request.routeOptions?.url ?? ""}`,
  });

  await fastify.register(fastifyCookie, {
    secret: config.JWT_SECRET, // used for cookie signing
  });

  await fastify.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: config.JWT_ACCESS_TTL, algorithm: "HS256" },
    verify: { algorithms: ["HS256"] },
  });

  await fastify.register(fastifyWebsocket, {
    options: {
      // Browser WS handshake with requested subprotocols succeeds only when
      // the server selects one and echoes it back.
      handleProtocols: selectWsClientProtocol,
    },
  });

  await fastify.register(fastifyMultipart, {
    limits: { fileSize: config.MAX_ATTACHMENT_BYTES },
  });

  // Error and not-found handlers MUST be set before any `register()` call.
  // Fastify encapsulation copies the parent handler into a child context at
  // registration time, so a handler installed afterwards does not cover routes
  // in already-registered plugin scopes — errors then fall through to Fastify's
  // default serializer, which echoes the raw error message (e.g. Postgres
  // `22P02 ... invalid input syntax for type uuid`) even in production.
  fastify.setNotFoundHandler(async (_, reply) => {
    return reply.code(404).send({ error: "Not found" });
  });

  // Never leak stack traces in production.
  fastify.setErrorHandler(async (error, request, reply) => {
    const maybeZod = error as {
      name?: string;
      issues?: unknown;
      errors?: unknown;
      flatten?: () => unknown;
    };
    if (maybeZod?.name === "ZodError") {
      return reply.code(400).send({
        error: "Validation error",
        details: typeof maybeZod.flatten === "function"
          ? maybeZod.flatten()
          : (maybeZod.issues ?? maybeZod.errors ?? []),
      });
    }
    if (error.validation) {
      return reply.code(400).send({ error: "Validation error", details: error.validation });
    }
    // Postgres `22P02` (invalid_text_representation) means a client-supplied
    // value could not be cast, e.g. a non-UUID path param bound to a UUID
    // column. That is malformed input, not a server fault, so answer 400 rather
    // than 500 — and avoid echoing the raw driver message. This centralizes
    // path-param validation instead of duplicating UUID schemas per route.
    if ((error as { code?: string }).code === "22P02") {
      return reply.code(400).send({ error: "Invalid request parameter" });
    }
    fastify.log.error({ err: error, url: stripQuery(request.url) }, "Unhandled error");
    const statusCode = error.statusCode ?? 500;
    return reply.code(statusCode).send({
      error: config.NODE_ENV === "production"
        ? "Internal server error"
        : error.message,
    });
  });

  await fastify.register(authRoutes, { prefix: "/auth" });
  await fastify.register(deviceRoutes, { prefix: "/devices" });
  await fastify.register(userRoutes, { prefix: "/users" });
  await fastify.register(messageRoutes, { prefix: "/messages" });
  await fastify.register(groupRoutes, { prefix: "/groups" });
  await fastify.register(groupMessageRoutes, { prefix: "/groups" });
  await fastify.register(attachmentRoutes, { prefix: "/attachments" });
  await fastify.register(callRoutes, { prefix: "/calls" });
  await fastify.register(roomRoutes, { prefix: "/rooms" });
  await fastify.register(pushRoutes, { prefix: "/push" });
  await fastify.register(clientErrorRoutes, { prefix: "/client-errors" });
  await fastify.register(transferRoutes, { prefix: "/transfer" });
  await fastify.register(plainConversationRoutes, { prefix: "/plain/conversations" });
  await fastify.register(plainMessageRoutes, { prefix: "/plain/messages" });
  await fastify.register(plainGroupRoutes, { prefix: "/plain/groups" });
  await fastify.register(plainAttachmentRoutes, { prefix: "/plain/attachments" });
  await fastify.register(plainPinRoutes, { prefix: "/plain/pins" });
  await fastify.register(plainFolderRoutes, { prefix: "/plain/folders" });
  await fastify.register(profileRoutes, { prefix: "/profile" });

  await registerWebSocketHandler(fastify);

  async function checkDependencies(): Promise<{ dbOk: boolean; redisOk: boolean }> {
    const dbOk = await pool.query("SELECT 1").then(() => true).catch(() => false);
    const redisOk = await redis.ping().then(r => r === "PONG").catch(() => false);
    cacheDepHealth(dbOk, redisOk);
    return { dbOk, redisOk };
  }

  // GET /health/live  — process liveness only, no external dep checks (cheap)
  fastify.get("/health/live", async () => {
    return { status: "ok", version: APP_VERSION };
  });

  // GET /health/ready — checks DB + Redis readiness (used by load balancers)
  fastify.get("/health/ready", async () => {
    const { dbOk, redisOk } = await checkDependencies();
    const status = dbOk && redisOk ? "ok" : "degraded";
    return { status, version: APP_VERSION, dependencies: { db: dbOk, redis: redisOk } };
  });

  // GET /health — legacy alias for /health/ready
  fastify.get("/health", async () => {
    const { dbOk, redisOk } = await checkDependencies();
    const status = dbOk && redisOk ? "ok" : "degraded";
    return { status, version: APP_VERSION };
  });

  fastify.get("/metrics", async (request, reply) => {
    if (
      config.NODE_ENV === "production" &&
      !isMetricsAuthorized(request.headers.authorization)
    ) {
      return reply.code(404).send({ error: "Not found" });
    }

    // Use cached dep health to avoid DB/Redis queries on every scrape.
    // Cached value is updated by /health/ready calls; if stale, do a fresh check.
    let health = getCachedDepHealth();
    if (!health) {
      const dbOk = await pool.query("SELECT 1").then(() => true).catch(() => false);
      const redisOk = await redis.ping().then(r => r === "PONG").catch(() => false);
      cacheDepHealth(dbOk, redisOk);
      health = { dbOk, redisOk };
    }
    reply.type("text/plain; version=0.0.4; charset=utf-8");
    return renderPrometheusMetrics(health);
  });

  return fastify;
}

const EXPECTED_LATEST_MIGRATION = "029_fcm_device_tokens.sql";

async function checkDbSchemaVersion(): Promise<void> {
  const rows = await query<{ filename: string }>(
    "SELECT filename FROM _migrations ORDER BY filename DESC LIMIT 1"
  );
  const latest = rows[0]?.filename;
  if (latest !== EXPECTED_LATEST_MIGRATION) {
    throw new Error(
      `Database schema is not up to date. Expected latest migration "${EXPECTED_LATEST_MIGRATION}", got "${latest ?? "none"}". Run migrations before starting the server.`
    );
  }
}

async function main() {
  await checkDbSchemaVersion();
  const app = await buildApp();

  // Periodic retention cleanup — runs 5 minutes after startup (plus random jitter to
  // avoid thundering herd when multiple replicas start simultaneously) then every 6 hours.
  const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const RETENTION_INITIAL_DELAY_MS = 5 * 60 * 1000 + Math.random() * 60_000;
  let retentionInterval: ReturnType<typeof setInterval> | null = null;
  const retentionTimer = setTimeout(() => {
    void runRetentionCleanup(app.log);
    retentionInterval = setInterval(() => void runRetentionCleanup(app.log), RETENTION_INTERVAL_MS);
    retentionInterval.unref();
  }, RETENTION_INITIAL_DELAY_MS);
  retentionTimer.unref();

  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down…`);
    clearTimeout(retentionTimer);
    if (retentionInterval) clearInterval(retentionInterval);

    const forceExitTimer = setTimeout(() => {
      app.log.error("Graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, 10_000).unref();

    await app.close();
    await pool.end();
    redis.disconnect();
    clearTimeout(forceExitTimer);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info({ host: config.HOST, port: config.PORT }, "API server started");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  await main();
}
