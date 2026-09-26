# Seclettr — Full Code & Delivery Audit

Date: 2026-09-26
Branch audited: `dev/main` @ `38bc2e4`
Method: read-only review of the whole monorepo (API, web, SFU, crypto, protocol,
infra, scripts, CI, tests, docs) plus manual verification of each critical claim.
No files were modified during the audit itself.

Severity legend: **Critical** (blocks release/install or enables account compromise),
**High** (serious security/correctness), **Medium**, **Low**.

> This document is a point-in-time snapshot. Items marked "(fixed)" were addressed
> in the remediation pass that followed the audit; see the git history for details.

---

## 1. Critical

### C1 — Install URL points at a branch where the installer does not exist
- `README.md:196,202`, `DEPLOYMENT.md:27` instruct:
  `https://raw.githubusercontent.com/stepan-pavlenko/seclettr/main/scripts/ops/install-bootstrap.sh`
- Verified: `git cat-file -e main:scripts/ops/install-bootstrap.sh` → `fatal: not in 'main'`.
  The default branch `main` still has the old flat layout (`scripts/install-bootstrap.sh`);
  the new CLI layout only exists on `dev/main`. Every documented install URL 404s for a fresh user.
- Additionally `main:README.md` still references `github.com/pavlenkosa/seclettr`, but the
  actual remote is `stepan-pavlenko/seclettr`.
- Fix: merge `dev/main` → `main` (or retarget docs), add a CI guard that README raw paths exist.

### C2 — Release pipeline never runs for the active branch
- `.github/workflows/release-bundle.yml:4-10` triggers on `workflow_run` for branch `main` only.
- Active development is `dev/main`; `.github/workflows/dev-bundle.yml` builds artifacts but
  never publishes a GitHub Release (no `softprops/action-gh-release`).
- Net effect: no downloadable release bundle is produced from the active branch, so the
  bootstrap installer cannot find an asset.
- Fix: promote `dev/main` to `main`, and/or publish a release from the dev bundle.

### C3 — Android release artifacts are unsigned and can silently be omitted
- `apps/web/android/app/build.gradle:19-24` has no `signingConfigs` and no `signingConfig`
  on the release build type, so `assembleRelease` produces an unsigned APK.
- `.github/workflows/release-bundle.yml:203-205` lists `app-release.apk`/`app-release.aab`
  with `fail_on_unmatched_files: false`; the dev branch removed the "skipped (no keystore)"
  fallback, so releases can succeed with no mobile artifacts at all.
- Fix (chosen): temporarily remove APK/AAB from releases until a real keystore + signing
  config exist; set `fail_on_unmatched_files: true` for the bundle itself.

### C4 — Group-call frame E2EE fails open in "required" mode
- `apps/web/src/calls/shared/crypto/frame-crypto-core.ts:283-296`: when no key is armed, the
  sender returns the raw frame (`return frameData`) and the receiver passes non-magic frames
  straight through. Plaintext RTP is transmitted/received while the UI reports "encrypted".
- `apps/web/src/calls/group/runtime/sfu/producer-runtime.ts:132` gates `required` only on
  browser support, not on key presence.
- Fix (done): fail closed — drop the frame and surface a downgrade signal; gate required mode
  on an armed key.

### C5 — Stored XSS via plain attachments (same-origin token theft)
- `apps/api/src/routes/plain/attachments.ts:117-180`: `contentType` is free-form and persisted,
  then used as `eq $Content-Type` in the presigned POST.
- `infra/nginx/nginx.conf:106-130`: the MinIO proxy location does not include
  `security-headers.conf` and sets no `Content-Disposition`, so attacker-controlled HTML/SVG
  can be served from the app origin. Because `/api/auth/refresh` is same-origin, a successful
  script can mint an access token → account takeover.
- Fix (done): restrict allowed MIME types, force `Content-Disposition: attachment` +
  `X-Content-Type-Options: nosniff` on the plain bucket proxy.

### C6 — E2E and external-SFU tests never run in CI
- `.github/workflows/dev-ci.yml:39-50` omits `QM_API_INCLUDE_INTEGRATION_TESTS`, so the 5 API
  integration suites (auth, attachment-access, group-history-contract, direct-call-signing-sync,
  guest-rooms) are silently skipped on `dev/main`.
- `tests/e2e` (Playwright) is referenced by no workflow; `group-call-sfu-bootstrap.test.ts`
  (`test:integration:external`) is never invoked.
- `apps/api/vitest.config.ts:14-28` gates integration by substring-matching `process.argv`,
  which is fragile.
- Fix: add the env flag to dev CI, wire e2e + external-SFU jobs, replace argv sniffing.

### C7 — Storage images no longer exist on Docker Hub (fresh install cannot start)
- `infra/docker-compose.yml:70,91`, `infra/docker-compose.release.yml:97,116`, and
  `scripts/release/install.sh:909-911` pull `minio/minio:latest` / `minio/mc:latest`.
- Verified 2026-09-26: Docker Hub returns `object not found` (404) for the `minio` namespace
  (`https://hub.docker.com/v2/repositories/minio/minio/`), while `postgres`, `redis`, and
  `coturn` resolve and pull normally from the same host/network.
  `docker pull minio/minio:latest` → `pull access denied ... repository does not exist`.
  `quay.io/minio/*` and `ghcr.io/minio/*` also return unauthorized/denied.
- Effect: a fresh install or `docker compose pull` fails at the storage service; the stack cannot
  start. This is independent of the audit branch and affects every deployment.
- Fix (done): images are now configurable (`MINIO_IMAGE` / `MINIO_MC_IMAGE`) and default to
  pinned, verified-working equivalents (`bitnamilegacy/minio:2025.7.23-debian-12-r5`,
  `bitnamilegacy/minio-client:2025.7.21-debian-12-r3`). `user: "0:0"` is set on the MinIO service
  because the replacement image defaults to UID 1001 and cannot write the root-owned data volume;
  the healthcheck and init container commands are unchanged. Verified end-to-end with
  `docker compose up minio minio-init`: healthy + bucket created.

---

## 2. High

### H1 — Cross-thread content disclosure via `replyToId`
- `apps/api/src/routes/plain/messages.ts:114,217` and `apps/api/src/routes/plain/groups.ts:812`
  accept any UUID as `replyToId` without verifying the target is in the same thread/group,
  visible to the sender, or not deleted. `HISTORY_SQL` does
  `LEFT JOIN plain_messages rp ON rp.id = pm.reply_to_id` and returns `rp.content`.
- Impact: a sender can reference a message from another user's thread and read its content via
  the reply preview.
- Fix (done): validate target thread/visibility/deletion before insert; reject otherwise.

### H2 — Insecure configuration defaults
- `apps/api/src/config.ts:16-40`: non-production auto-loads `infra/.env.dev|.env.sandbox|.env`.
- `:42-52,65`: `EnvBooleanSchema` resolves `undefined`/`""` to **true**, so
  `ALLOW_PUBLIC_REGISTRATION` defaults to open registration.
- `:55`: `NODE_ENV` defaults to `development`, disabling every production guard.
- Impact: a bare-metal `pnpm start` without `NODE_ENV=production` runs with open registration
  and weak-secret allowances.
- Fix (done): `NODE_ENV` must be explicit; `ALLOW_PUBLIC_REGISTRATION` defaults to false;
  dotenv loader only under an explicit opt-in / test.

### H3 — Attachment verification buffers whole objects in memory
- `apps/api/src/routes/attachments/index.ts:170-244`: `verifyAttachmentObject` /
  `fetchAttachmentObjectBytes` load up to `MAX_ATTACHMENT_BYTES` (default 100 MiB) into the
  process to hash it. Concurrent verifications exhaust heap.
- Fix (done): stream into `crypto.createHash` instead of buffering the full blob.

### H4 — Access tokens survive logout
- `apps/api/src/middleware/auth.ts:23-39` only verifies the JWT (`tokenUse==="access"`) and
  never consults `auth_sessions`, so a revoked session's access token (and its WS connection)
  remains valid until expiry.
- Fix (done): check session liveness on protected requests and WS connect.

### H5 — WebSocket Authorization header does not enforce `tokenUse`
- `apps/api/src/services/ws-auth.ts:85-96`: for the `Authorization` header source, no
  `tokenUse` check is performed, so a `guest`/`contact` token can open `/ws`.
- Fix (done): require `ws`/`access` for all sources.

### H6 — Android backup can exfiltrate E2EE material
- `apps/web/android/app/src/main/AndroidManifest.xml:5` sets `android:allowBackup="true"`.
- `res/xml/backup_rules.xml` / `res/xml/data_extraction_rules.xml` exclude only two
  SharedPreferences files; IndexedDB lives under `app_webview/` and is not excluded.
- Fix (done): disable backup / exclude webview storage.

### H7 — Media-key ACK can be forged
- `apps/web/src/calls/group/runtime/media-key/media-key-ack-proof.ts:63`: `if (!proof) return true`.
- `apps/web/src/calls/group/runtime/useGroupCallInboundAckVerification.ts:49-51`: an unknown
  `keyId` is verified against `new Uint8Array(32)` (all-zero key) and then acknowledged.
- Fix (done): require the proof; reject ACKs with no matching local key.

### H8 — Media keys are not zeroized on teardown
- `apps/web/src/calls/direct/runtime/useDirectCallFrameCryptoRuntime.ts:155-179` clears refs but
  never `fill(0)`s `sendKeyBytes`/`recvKeyBytes`.
- `apps/web/src/calls/group/runtime/sfu/consumer-manager.ts:63,304` drops
  `remoteFrameKeyContextsByDeviceId` without zeroizing raw key bytes.
- Fix (done): zero key buffers on close/reconfigure.

### H9 — Third-party notices generator is a silent no-op
- `scripts/generate-third-party-notices.mjs:90-101` reads `rawEntry.version` / `rawEntry.path`,
  but `pnpm licenses list --prod --json` emits `versions: []` / `paths: []`. Every entry is
  skipped, `packages.length === 0`, and the script exits 0 before the `--check` comparison.
- Impact: `pnpm licenses:third-party:check`, the git pre-commit hook, and `release:build`
  cannot detect a stale `THIRD_PARTY_NOTICES.md` (legal/compliance false negative).
- Fix (done): iterate `versions` × `paths`; make `--check` compare even at zero packages.

### H10 — Base Compose web service is broken on Linux
- `infra/docker-compose.yml:228-229`: healthcheck probes `http://127.0.0.1:8080`, which nginx
  answers with a 301 to HTTPS (`infra/nginx/nginx.conf:45-49`), so web is never healthy.
- `infra/docker-compose.yml:215-233`: `web` has no `extra_hosts`, but
  `infra/nginx/nginx.conf:34-37` declares `upstream sfu { server host.docker.internal:3002; }`,
  which is unresolvable on Linux without `host-gateway` → nginx exits at startup.
- Fix (done): add `extra_hosts`, fix the healthcheck.

### H11 — `seclettr dev test-env` writes to a non-existent path
- `scripts/dev/test-env.sh:4-6`: `ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"` resolves to
  `scripts/`, so `TARGET="$ROOT/infra/.env.test"` = `scripts/infra/.env.test`.
- Fix (done): `../..`.

### H12 — Installer leaves secrets and keys world-readable
- `scripts/release/install.sh:569,604,629,645,1690`: `chmod 644 key.pem`.
- `scripts/release/install.sh:1865-1869`: `.env` created with the default umask, never
  restricted.
- Fix (done): `chmod 600` for `.env`, `640` for private keys.

### H13 — SFU resource exhaustion and weak access control
- `apps/sfu/src/sfu-server.ts:267,346,459`: no caps on transports/producers/consumers/rooms.
- `apps/sfu/src/http-rate-limit.ts:19,64`: unbounded bucket Map with O(n) prune per request;
  `trustProxy: "loopback, linklocal, uniquelocal"` (`config.ts:102-103`) lets a LAN client
  spoof `X-Forwarded-For` and mint unlimited keys.
- `apps/sfu/src/sfu-server.ts:585-588`: `DELETE /rooms/:roomId/peers/:userId` does not call
  `ensureRoomAccess`.
- Fix (done): room access now enforced on peer delete; `maxRooms`/`maxPeersPerRoom`/
  `maxTransportsPerPeer`/`maxProducersPerPeer`/`maxConsumersPerPeer` caps added (503 on room cap,
  429 on per-device caps); rate-limit key no longer mixes spoofable `request.ip`; bucket Map
  bounded (`maxBuckets`) with opportunistic prune and fail-closed overflow. Caps are configurable
  via `SFU_MAX_*` / `SFU_RATE_LIMIT_MAX_BUCKETS`.

### H14 — Crypto memory/aliasing defects
- `packages/crypto/src/x3dh.ts:102-118`: `dh4` is not zeroized in the OTK branch.
- `packages/crypto/src/sender-keys.ts:137-149`: `cachedMk.fill(0)` mutates a `Uint8Array` owned
  by the caller's `state.MKSKIPPED`, permanently corrupting that state.
- Fix (done): `dh4` zeroized after concat; cached MK cloned before decrypt so only the clone is
  zeroized and `state.MKSKIPPED` is left intact. Regression test covers cache reuse across calls.

### H15 — Unbounded protocol schemas
- `packages/protocol/src/websocket.ts:72,104,156`: `sdp`, `candidate`, `rtpCapabilities` are
  unbounded `z.string()`.
- `packages/protocol/src/media-encryption.ts:58`: `encryptedKey` unbounded.
- `packages/protocol/src/common.ts:17-29`: recursive `JsonValueSchema` with no depth/node limit.
- Fix (done): `sdp`/`candidate`/`rtpCapabilities`/`encryptedKey` bounded via `MAX_*_LENGTH`;
  `JsonObjectSchema` uses `z.preprocess` with an iterative depth/node bound checked *before* the
  recursive parse (fails closed instead of overflowing the stack). Tests added.

---

## 3. Medium (selection)

Web
- No request timeouts on the API/session `fetch` paths (`apps/web/src/lib/api/client.ts:75-129`,
  `src/lib/session-preview.ts:115`).
- Logger redaction short-circuits at `depth > 2` (`src/lib/logger.ts:63`), leaking deep nested
  values in production.
  - Fix (done): values beyond the depth bound are replaced with `[Truncated]` instead of returned
    raw; sanitizer exported and covered by `logger-sanitize.test.ts`.
- Saved messages and part of the plain cache are plaintext/weakly encrypted at rest
  (`src/stores/saved/useSavedMessagesStore.ts:47`, `src/stores/plain/messages/plain-messages-cache.ts:30-46`).
- `String.fromCodePoint(...blob)` can throw `RangeError` for large caches
  (`plain-messages-cache.ts:84`).
  - Fix (done): encode in 8 KB chunks (matching the attachment base64 pattern).

API
- Group member-count check is outside a transaction (`apps/api/src/routes/groups/index.ts:430-470`).
  - Fix (done): count check + inserts now run inside a transaction that locks the group row
    (`SELECT ... FOR UPDATE`), preventing concurrent add-member calls from exceeding the cap.
- Refresh-token rotation has no row lock / reuse detection (`routes/auth/index.ts:565-605`).
- `/metrics` bearer comparison is not constant-time (`src/index.ts:214-222`).
  - Fix (done): constant-time comparison via `lib/constant-time.ts` (hashes both sides to a fixed
    length before `timingSafeEqual`).
- Path params are generally not UUID-validated → 500 on malformed input.

Infra / CI / supply chain
- `minio`, `mc`, `coturn` pinned to `:latest`.
- No resource limits / `no-new-privileges` / `cap_drop` in compose.
- Actions pinned to mutable tags; no Dependabot/SBOM/cosign/Sonar.
- Automated release always uses `--skip-verify`; `cancel-in-progress: true` on release.
- Dockerfiles copy the whole build tree into runtime images.
- `scripts/release/install.sh:215-258` installs the CentOS Docker repo on Fedora/RHEL.

Tests
- No coverage thresholds; coverage only for 3 of 5 packages.
- No `apps/web/vitest.config.ts`; 238 test files rely on per-file environment docblocks.
- `apps/api/src/db/migrate.ts` baseline map omits migrations 015/027/029 and is untested.
  - Fix (done): baseline checks added for 015/027/029; `migrate-baseline.test.ts` fails if any
    migration file lacks a baseline entry.

Docs
- No `CHANGELOG`, `SECURITY`, `CODEOWNERS`, or `CONTRIBUTING`.
- `DEPLOYMENT.md` omits the SFU RTP range `40000-49999`.

---

## 4. Positive observations

- All SQL is parameterized; no string-concatenated user input reaches SQL.
- No `dangerouslySetInnerHTML`, `eval`, `innerHTML`, or dynamic `Function` in the web app.
- Access tokens are memory-only; refresh tokens use HttpOnly cookies on web.
- No `@ts-ignore` / `@ts-expect-error` / explicit `any` / TODO in non-test source.
- Private keys are never sent to the server; only public material is uploaded.
- Argon2id is used for the app-lock PIN with constant-time comparison.
- WebSocket client has backoff+jitter, bounded queue, protocol-version hard fail.
- Guest-room SFU access validates the guest session still exists after kick.

---

## 5. Recommended remediation order

1. Unblock delivery: merge `dev/main` → `main`, fix install URLs, notices generator, compose,
   installer permissions, Android release handling. (Phase 0)
2. Close critical security: frame-crypto fail-closed, media-key ACK proof, plain-attachment
   XSS, `replyToId` validation, config defaults, attachment streaming, session revocation,
   Android backup, media-key zeroization. (Phase 1)
3. Harden and instrument: SFU limits, crypto memory fixes, protocol bounds, CI e2e/coverage/
   security scanning, migrations tests, docs. (Phase 2)
