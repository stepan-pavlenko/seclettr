/// <reference types="vitest" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import basicSsl from "@vitejs/plugin-basic-ssl";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as { version: string };

const require = createRequire(import.meta.url);
const libsodiumWrappersPath = require.resolve("libsodium-wrappers-sumo");
const mediasoupClientPath = require.resolve("mediasoup-client");

// Resolve to the real package when installed; fall back to a no-op stub so
// environments that haven't run `pnpm install` (e.g. Docker containers) still
// boot without crashing. The full tracing behaviour is available on the host
// where the package is present.
let wdyrResolved: string | null = null;
try {
  wdyrResolved = require.resolve("@welldone-software/why-did-you-render");
} catch {
  // Not installed — stub it at Vite resolution time.
}
const devApiHost = process.env["VITE_DEV_API_HOST"] ?? "127.0.0.1";
const devApiPort = Number(process.env["VITE_DEV_API_PORT"] ?? "3001");
const devSfuHost = process.env["VITE_DEV_SFU_HOST"] ?? devApiHost;
const devSfuPort = Number(process.env["VITE_DEV_SFU_PORT"] ?? "3002");
const devMinioHost = process.env["VITE_DEV_MINIO_HOST"] ?? "127.0.0.1";
const devMinioPort = Number(process.env["VITE_DEV_MINIO_PORT"] ?? "59000");
const devMinioBucket = process.env["VITE_DEV_MINIO_BUCKET"] ?? "seclettr-attachments";
// The Host header value that the API's S3 client used when signing presigned URLs.
// Must match S3_ENDPOINT's host:port in the API so MinIO's SigV4 check passes.
const devMinioSigningHost = process.env["VITE_DEV_MINIO_SIGNING_HOST"] ?? "minio:9000";
const devApiOrigin = `http://${devApiHost}:${devApiPort}`;
const devWsOrigin = `ws://${devApiHost}:${devApiPort}`;
const devSfuOrigin = `http://${devSfuHost}:${devSfuPort}`;
const devMinioOrigin = `http://${devMinioHost}:${devMinioPort}`;
const devHost = process.env["VITE_DEV_HOST"] ?? "0.0.0.0";
const devHttpsKeyFile = process.env["VITE_DEV_HTTPS_KEY_FILE"];
const devHttpsCertFile = process.env["VITE_DEV_HTTPS_CERT_FILE"];
const devHttpsCaFile = process.env["VITE_DEV_HTTPS_CA_FILE"];
const devHttpsConfig = devHttpsKeyFile && devHttpsCertFile
  ? {
      key: fs.readFileSync(devHttpsKeyFile),
      cert: fs.readFileSync(devHttpsCertFile),
      ca: devHttpsCaFile ? fs.readFileSync(devHttpsCaFile) : undefined,
    }
  : undefined;
const buildSourcemap = process.env["SECLETTR_BUILD_SOURCEMAP"] === "true";
const DEFAULT_JS_CHUNK_BUDGET = 260 * 1024;
const DEFAULT_CSS_ASSET_BUDGET = 40 * 1024;
const DEFAULT_STATIC_ASSET_BUDGET = 300 * 1024;

const JS_CHUNK_BUDGETS = {
  index: 52 * 1024,
  ChatPage: 360 * 1024,
  MessageComposer: 260 * 1024,
  MediaSendDialog: 60 * 1024,
  "composer-emoji-data": 260 * 1024,
  "feature-calls-shared-ui": 90 * 1024,
  "feature-calls-shared-runtime": 96 * 1024,
  "shared-realtime": 40 * 1024,
  "feature-direct-calls": 405 * 1024,
  "feature-group-calls": 400 * 1024,
  RoomCallPanel: 160 * 1024,
  "vendor-react": 160 * 1024,
  "vendor-router": 10 * 1024,
  "vendor-state": 8 * 1024,
  "vendor-debug": 10 * 1024,
  "vendor-misc": 175 * 1024,
  "vendor-protocol": 100 * 1024,
  "vendor-calls": 200 * 1024,
  "vendor-crypto": 220 * 1024,
  // The libsodium wrapper and its WASM payload are intentionally isolated into
  // a lazy chunk so auth/chat/call boot paths don't eagerly download them.
  "vendor-sodium": 1_024 * 1024,
} as const;

const CSS_ASSET_BUDGETS = {
  ChatPage: 130 * 1024,
  MessageComposer: 45 * 1024,
  "feature-calls-shared-ui": 55 * 1024,
  "feature-direct-calls": 32 * 1024,
  "feature-group-calls": 80 * 1024,
  index: 40 * 1024,
} as const;

const STATIC_ASSET_BUDGETS = {
  "seclettr-marimba": 1_700 * 1024,
} as const;

function formatBudgetSize(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} kB`;
}

function stripAssetHash(fileName: string): string {
  const baseName = path.basename(fileName).replace(/\.[^.]+$/, "");
  const hashSeparatorIndex = baseName.lastIndexOf("-");

  if (hashSeparatorIndex <= 0) {
    return baseName;
  }

  const possibleHash = baseName.slice(hashSeparatorIndex + 1);
  return /^[A-Za-z0-9_-]{8,}$/.test(possibleHash)
    ? baseName.slice(0, hashSeparatorIndex)
    : baseName;
}

function resolveAssetSize(source: unknown): number | null {
  if (typeof source === "string") {
    return Buffer.byteLength(source, "utf8");
  }

  if (source instanceof Uint8Array) {
    return source.byteLength;
  }

  return null;
}

function resolveNamedBudget<T extends Record<string, number>>(
  budgets: T,
  name: string,
  fallback: number
): number {
  const exactBudget = budgets[name as keyof T];
  if (exactBudget !== undefined) {
    return exactBudget;
  }

  // Vite/Rollup hashes may contain dashes, for example:
  // `feature-group-calls-BdYoAd-V.css`. A naive split by the last dash would
  // leave `feature-group-calls-BdYoAd` and miss the configured budget, so match
  // hashed asset names against the known budget prefixes as a second pass.
  const prefixMatch = Object.keys(budgets)
    .filter((budgetName) => name.startsWith(`${budgetName}-`))
    .sort((left, right) => right.length - left.length)[0];

  return prefixMatch ? budgets[prefixMatch as keyof T] : fallback;
}

function bundleBudgetPlugin(): Plugin {
  return {
    name: "seclettr-bundle-budgets",
    apply: "build",
    generateBundle(
      this: { error: (message: string) => never },
      _: unknown,
      bundle: Record<string, unknown>
    ) {
      const violations: string[] = [];

      for (const entry of Object.values(bundle)) {
        if (!entry || typeof entry !== "object" || !("type" in entry)) {
          continue;
        }

        if (
          entry.type === "chunk"
          && "name" in entry
          && typeof entry.name === "string"
          && entry.name
          && "code" in entry
          && typeof entry.code === "string"
        ) {
          const budget = resolveNamedBudget(JS_CHUNK_BUDGETS, entry.name, DEFAULT_JS_CHUNK_BUDGET);
          const size = Buffer.byteLength(entry.code, "utf8");
          if (size > budget) {
            violations.push(
              `${entry.name}: ${formatBudgetSize(size)} > ${formatBudgetSize(budget)}`
            );
          }
          continue;
        }

        if (
          entry.type === "asset"
          && "fileName" in entry
          && typeof entry.fileName === "string"
          && "source" in entry
        ) {
          const size = resolveAssetSize(entry.source);
          if (size === null) continue;

          const budgetKey = stripAssetHash(entry.fileName);
          const budget = entry.fileName.endsWith(".css")
            ? resolveNamedBudget(CSS_ASSET_BUDGETS, budgetKey, DEFAULT_CSS_ASSET_BUDGET)
            : resolveNamedBudget(STATIC_ASSET_BUDGETS, budgetKey, DEFAULT_STATIC_ASSET_BUDGET);

          if (size > budget) {
            violations.push(
              `${entry.fileName}: ${formatBudgetSize(size)} > ${formatBudgetSize(budget)}`
            );
          }
        }
      }

      if (violations.length > 0) {
        this.error(`Bundle budget exceeded:\n${violations.join("\n")}`);
      }
    },
  };
}

function resolveManualChunk(id: string): string | undefined {
  const normalizedId = id.toLowerCase();

  if (
    id.includes("/src/chats/composer/composer-emoji-catalog")
    || id.includes("/src/chats/composer/composer-emoji-data.generated")
  ) {
    return "composer-emoji-data";
  }

  if (id.includes("/src/calls/shared/presentation/")) {
    return "feature-calls-shared-ui";
  }

  if (
    id.includes("/src/calls/shared/media/")
    || id.includes("/src/calls/shared/crypto/")
    || id.includes("/src/calls/shared/model/")
  ) {
    return "feature-calls-shared-runtime";
  }

  // WebSocket client must live in a shared chunk that precedes both call
  // feature chunks. Without this, Rollup absorbs it into feature-group-calls
  // while stores/auth (in feature-direct-calls) calls wsClient.setAuthErrorHandler
  // at module-init time → TDZ crash on the circular chunk evaluation order.
  if (id.includes("/src/lib/websocket")) {
    return "shared-realtime";
  }

  if (id.includes("/src/calls/direct/")) {
    return "feature-direct-calls";
  }

  if (id.includes("/src/calls/group/")) {
    return "feature-group-calls";
  }

  if (id.includes("libsodium-wrappers-sumo") || normalizedId.includes("sodium")) {
    return "vendor-sodium";
  }

  if (id.includes("/packages/crypto/")) {
    return "vendor-crypto";
  }

  if (id.includes("/packages/protocol/") || id.includes("/node_modules/zod/")) {
    return "vendor-protocol";
  }

  if (id.includes("mediasoup-client")) {
    return "vendor-calls";
  }

  if (id.includes("react-router-dom")) {
    return "vendor-router";
  }

  if (
    id.includes("/node_modules/react/")
    || id.includes("/node_modules/react-dom/")
    || id.includes("/node_modules/scheduler/")
  ) {
    return "vendor-react";
  }

  if (id.includes("/node_modules/zustand/") || id.includes("/node_modules/idb/")) {
    return "vendor-state";
  }

  if (id.includes("/node_modules/debug/") || id.includes("/node_modules/ms/")) {
    return "vendor-debug";
  }

  if (id.includes("/node_modules/")) {
    return "vendor-misc";
  }

  return undefined;
}

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    ...(devHttpsConfig ? [] : [basicSsl()]),
    bundleBudgetPlugin(),
    VitePWA({
      // The app shell SW is public/push-sw.js which also handles push notifications.
      // Since only one SW can be active per scope, Workbox injection is disabled.
      // Offline fallback caching is implemented directly in push-sw.js.
      registerType: "autoUpdate",
      injectRegister: false,
      devOptions: { enabled: true },
      includeAssets: ["favicon.svg"],
      workbox: {
        inlineWorkboxRuntime: true,
      },
      manifest: {
        name: "Seclettr",
        short_name: "Seclettr",
        description: "End-to-end encrypted messenger and calls",
        theme_color: "#0f1b33",
        background_color: "#0a1326",
        display: "standalone",
        display_override: ["standalone", "minimal-ui"],
        orientation: "portrait",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "favicon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "libsodium-wrappers-sumo": libsodiumWrappersPath,
      "mediasoup-client": mediasoupClientPath,
      // When the real package is absent, alias to a no-op so the app boots.
      ...(wdyrResolved === null
        ? { "@welldone-software/why-did-you-render": path.resolve(__dirname, "./src/lib/wdyr-stub.ts") }
        : {}),
    },
  },
  server: {
    port: 5173,
    host: devHost,
    https: devHttpsConfig,
    // Reflect the request Origin back so credentialed requests (credentials: "include")
    // from non-browser origins like capacitor://localhost work correctly.
    // The default Vite cors: '*' is rejected by the browser when credentials are sent.
    cors: { origin: true, credentials: true },
    // In development Vite / React Fast Refresh inject an inline <script> preamble
    // that the strict CSP meta tag in index.html blocks. Sending a permissive
    // Content-Security-Policy header from the dev server overrides the meta tag
    // so HMR and Fast Refresh work normally. The meta tag still applies in the
    // production build where no inline scripts are injected.
    headers: {
      "Permissions-Policy": "camera=(self), microphone=(self), geolocation=(), display-capture=(self)",
      "Content-Security-Policy": [
        "default-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
        "frame-src 'none'",
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https://*.giphy.com https://media.giphy.com",
        "font-src 'self' data:",
        "connect-src 'self' http: https: ws: wss:",
        "media-src 'self' blob: data:",
        "worker-src 'self' blob:",
        "manifest-src 'self'",
      ].join("; "),
    },
    proxy: {
      "/api": {
        target: devApiOrigin,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
      "/ws": {
        target: devWsOrigin,
        ws: true,
      },
      "/sfu": {
        target: devSfuOrigin,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/sfu/, ""),
      },
      // MinIO presigned URL proxy — keeps browser requests on the same HTTPS
      // origin (Vite dev server) rather than hitting MinIO over plain HTTP.
      // S3_PUBLIC_URL in the API must be set to the Vite dev server origin so
      // the API rewrites presigned URLs to this prefix.
      //
      // The Host header is overridden to devMinioSigningHost so MinIO's SigV4
      // verification uses the same host value that the API's S3 client signed
      // against (its internal S3_ENDPOINT, e.g. minio:9000).
      [`/${devMinioBucket}`]: {
        target: devMinioOrigin,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("host", devMinioSigningHost);
          });
        },
      },
      [`/${devMinioBucket}-plain`]: {
        target: devMinioOrigin,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("host", devMinioSigningHost);
          });
        },
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // When NODE_ENV is overridden externally (e.g. NODE_ENV=test in CI) Vite
    // inherits that value and skips React's production dead-code elimination,
    // inflating vendor-react from ~143 kB to ~333 kB. Explicitly pinning it
    // here ensures consistent production-sized bundles regardless of the host
    // environment's NODE_ENV.
    ...(command === "build" ? { "process.env.NODE_ENV": JSON.stringify("production") } : {}),
  },
  build: {
    target: "es2022",
    sourcemap: buildSourcemap,
    // Vite's generic warning threshold is lower than our explicit bundle budget
    // policy and flags the isolated lazy sodium/WASM chunk even when the eager
    // app graph is healthy. Keep the stricter plugin budgets as the gate.
    chunkSizeWarningLimit: 1_100,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === "CIRCULAR_DEPENDENCY" || warning.message?.startsWith("Circular chunk:")) return;
        warn(warning);
      },
      output: {
        manualChunks: resolveManualChunk,
      },
    },
  },
  optimizeDeps: {
    include: ["libsodium-wrappers-sumo"],
  },
  test: {
    // Per-file `@vitest-environment` docblocks still take precedence; this
    // default matches the node environment most component-free tests assume.
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text-summary"],
      // Ratchet thresholds, set just below current coverage so regressions
      // fail CI without blocking unrelated work (AUDIT.md Tests).
      thresholds: {
        lines: 60,
        statements: 60,
        functions: 60,
        branches: 65,
      },
    },
  },
}));
