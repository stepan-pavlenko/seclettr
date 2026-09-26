# Deployment Guide (Step-by-Step)

This guide is written for first-time operators.
You do not need to build from source.

---

## Installation Modes

All deployment paths use the **release bundle** — a `.tar.gz` that contains the compose
file, nginx configs, migrations, and installer script.

| Mode | Image source | Bundle size |
|------|-------------|-------------|
| **One-line install** (recommended) | Latest release bundle from GitHub Releases (prebuilt images) | ~1 GB |
| **Offline / air-gapped** | Same bundle, copied manually | ~1 GB |
| **Pure online** (advanced) | Pulled from `ghcr.io/stepan-pavlenko/seclettr/*` at install time | ~10 MB (configs only) |

For the pure-online path the GHCR packages must be public (or you must run
`docker login ghcr.io` first). The release bundle is offline-first: it always
contains `prebuilt-images.tar.gz`, and the installer loads from it when present.
The one-line bootstrap installs from the bundle, so no registry access is needed.

```bash
# Recommended: one-line install (installs Docker, downloads bundle, verifies
# checksum, generates secrets + self-signed cert, runs migrations, starts stack)
curl -fsSL https://raw.githubusercontent.com/stepan-pavlenko/seclettr/main/scripts/ops/install-bootstrap.sh | sudo bash
```

---

## Quick Start

### 1. Prerequisites

- Linux server (Ubuntu 22.04+ recommended)
- Docker + Docker Compose plugin
- Open ports: `80` and `443` (web), `3478` UDP/TCP + `50000–51999` UDP (TURN)
- SFU media over UDP `40000–49999` (required for group/room calls; see `RTC_MIN_PORT`/`RTC_MAX_PORT`)
- A domain name pointing at the server (recommended for production)

Install Docker if missing:
```bash
curl -fsSL https://get.docker.com | sh
```

### 2. Download the Release Bundle

Go to the [GitHub Releases](https://github.com/stepan-pavlenko/seclettr/releases) page and
download the latest assets:

```
seclettr-release-main-<timestamp>.tar.gz
seclettr-release-main-<timestamp>.tar.gz.sha256
```

Or with curl:
```bash
# Replace <tag> with the release tag, e.g. v1.3.1-beta
RELEASE_URL="https://github.com/stepan-pavlenko/seclettr/releases/download/<tag>"
curl -fLO "$RELEASE_URL/seclettr-release-main-<timestamp>.tar.gz"
curl -fLO "$RELEASE_URL/seclettr-release-main-<timestamp>.tar.gz.sha256"
```

Verify integrity:
```bash
sha256sum -c seclettr-release-main-<timestamp>.tar.gz.sha256
```

### 3. Unpack and Configure

```bash
tar -xzf seclettr-release-main-<timestamp>.tar.gz
cd seclettr-release-main-<timestamp>
```

The installer generates cryptographic secrets automatically. You only need to set
network-specific values that it cannot guess:

```bash
# Open .env and set:
#   CORS_ORIGIN   — URL your users will access (e.g. https://chat.example.com)
#   TURN_DOMAIN   — domain or IP of the TURN server (same host is fine)
#   TURN_EXTERNAL_IP / ANNOUNCED_IP — public IP of the server
```

### 4. Run Installer

```bash
# Interactive (recommended for first deploy)
./install.sh --interactive

# Non-interactive (CI/automation)
./install.sh --non-interactive --mode full --network tls
```

The installer will:
1. Pull Docker images from GHCR (online mode) or load from bundle (offline mode)
2. Generate secrets for any `CHANGE_ME_*` placeholders
3. Run database migrations
4. Start all services

### 5. Verify

```bash
# Check service health
docker compose -p seclettr --env-file .env -f docker-compose.yml ps

# API should return {"status":"ok"}
curl http://127.0.0.1:3001/health
```

---

## Release Bundle Installation (Online or Offline)

### 1. Download the Bundle from GitHub

1. Open the repository page on GitHub.
2. Go to **Releases**.
3. Download the latest **Seclettr Main Snapshot** assets:
- `seclettr-release-main-<timestamp>.tar.gz`
- `seclettr-release-main-<timestamp>.tar.gz.sha256`

### 2. Verify Download Integrity

```bash
sha256sum -c seclettr-release-main-<timestamp>.tar.gz.sha256
```

Expected result: `OK`.

### 3. Unpack the Bundle

```bash
tar -xzf seclettr-release-main-<timestamp>.tar.gz
cd seclettr-release-main-<timestamp>
```

### 4. Prepare Environment File

The installer generates secrets automatically on first run, so you can skip this step.

If you want to review or customise values before the first run:
```bash
cp .env.example .env
```

Open `.env` and adjust:
- `CORS_ORIGIN` — the URL your users will access (e.g. `https://chat.example.com`)
- `TURN_DOMAIN` — domain or IP of the TURN server
- `TURN_EXTERNAL_IP` / `ANNOUNCED_IP` — public IP of the server (auto-detected if omitted)

All cryptographic secrets are generated automatically if you leave them as `CHANGE_ME_*` placeholders.

### 5. Choose Deployment Mode

| Mode | Services | Best for |
|------|----------|----------|
| `full` | web + API + SFU + infra | Single-server deployment (recommended) |
| `backend` | API + SFU + infra (no web) | Separate web/backend deployments |
| `web` | web only | External backend URL |

### 6. TLS or HTTP

#### Production (recommended): TLS
- If `./nginx/certs/cert.pem` and `key.pem` are absent, the installer generates a **self-signed certificate** automatically.
- To use a trusted certificate (Let's Encrypt, etc.), place files into `./nginx/certs/` **before** running the installer:
  - `cert.pem`
  - `key.pem`
- Keep `NETWORK_MODE=tls`.

> **Note:** Self-signed certificates will trigger a browser security warning.
> Replace them with a CA-signed certificate for public-facing deployments.

#### Local/test only: HTTP
- Use `--network http` at install time.

### 7. Run Installer

#### Interactive (recommended for first run)

```bash
./install.sh --interactive
```

#### Non-interactive examples

```bash
# Full stack over TLS
./install.sh --mode full --network tls

# Backend only
./install.sh --mode backend --non-interactive

# Web only targeting external backend
./install.sh --mode web --network http \
  --web-api-url https://api.example.com/api \
  --web-sfu-url https://api.example.com/sfu
```

---

## Post-Installation

### Check That Services Are Healthy

```bash
docker compose -p seclettr --env-file .env -f docker-compose.yml ps
```

Then verify:
- API health: `http://127.0.0.1:3001/health`
- Web:
  - `https://<your-domain>` (TLS mode)
  - `http://<your-domain>` (HTTP mode)

### Common Operations

| Operation | Command |
|-----------|---------|
| View logs | `docker compose -p seclettr --env-file .env -f docker-compose.yml logs -f` |
| Restart services | `docker compose -p seclettr --env-file .env -f docker-compose.yml restart` |
| Stop stack | `docker compose -p seclettr --env-file .env -f docker-compose.yml down` |
| Pull updates | `docker compose -p seclettr --env-file .env -f docker-compose.yml pull` |

---

## Update to a New Version

### Online Mode (Using GHCR)

```bash
cd /opt/seclettr

# Pull new images
docker compose pull

# Restart with new images
docker compose up -d
```

### Release Bundle Update

The release bundle has a built-in update mode. It keeps Docker volumes in place, copies your runtime configuration, and restarts containers.

#### Easiest update path

Upload the new release archive into the current unpacked release directory and run:

```bash
cd /path/to/current/seclettr-release-main-<old-timestamp>
./install.sh --update ./seclettr-release-main-<new-timestamp>.tar.gz
```

The current installer will:
- unpack the new archive next to the current release directory
- hand off to the new archive's `install.sh`
- copy `.env` and TLS certificates from the current release
- create a backup
- load new Docker images
- run database migrations
- restart containers without deleting Docker volumes

#### Manual update path

```bash
# 1. Download and verify the new bundle
sha256sum -c seclettr-release-main-<new-timestamp>.tar.gz.sha256

# 2. Unpack the new bundle
tar -xzf seclettr-release-main-<new-timestamp>.tar.gz
cd seclettr-release-main-<new-timestamp>

# 3. Run update, pointing to the previous unpacked release directory
./install.sh update --from /path/to/previous/seclettr-release-main-<old-timestamp>
```

During update the installer creates `backups/update-<timestamp>/` with:
- `.env`
- TLS certificates, if present
- `runtime-config.js`, if present
- `postgres.sql.gz`, if the previous Postgres container is running

Do not run `uninstall.sh` for an update unless you intentionally want to remove
the deployment. The update flow does not remove Docker volumes, so Postgres and
MinIO data remain in place.

---

## Security Notes

- Do not expose Postgres/Redis/MinIO ports publicly.
- Use strong secrets in `.env`.
- Use TLS in production.
- Keep Docker host and OS patched.
- Read legal notices: `LEGAL_NOTICE.md`
