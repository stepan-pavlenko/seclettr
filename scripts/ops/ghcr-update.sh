#!/usr/bin/env bash
# ─── Seclettr GHCR Update ─────────────────────────────────────────────
#
# Pulls the latest images from GitHub Container Registry and restarts
# the stack with automatic DB backup and migration.
#
# Usage:
#   ./scripts/ghcr-update.sh                    # dry-run
#   ./scripts/ghcr-update.sh --apply            # apply
#   ./scripts/ghcr-update.sh --tag v1.2.0       # specific tag (default: latest)
#   ./scripts/ghcr-update.sh --rollback         # restore previous backup
#
set -euo pipefail

_sc="$(readlink -f "${BASH_SOURCE[0]}")" && SCRIPT_DIR="$(cd -- "$(dirname -- "$_sc")/.." && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GHCR_REGISTRY="ghcr.io"
GHCR_NAMESPACE="stepan-pavlenko/seclettr"
IMAGE_TAG="latest"
SECLETTR_VERSION="$(node -e "console.log(require('$ROOT_DIR/package.json').version)")"
COMPOSE_DIR="${SECLETTR_COMPOSE_DIR:-/opt/seclettr}"
COMPOSE_FILE="${COMPOSE_DIR}/docker-compose.yml"
ENV_FILE="${COMPOSE_DIR}/.env"
BACKUP_DIR="${COMPOSE_DIR}/backups/ghcr-update-$(date +%Y%m%d-%H%M%S)"
PROJECT_NAME="seclettr"

APPLY=false
ROLLBACK=false

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[0;33m'; CYN='\033[0;36m'; BLD='\033[1m'; DIM='\033[2m'; RST='\033[0m'
ok()   { echo -e "  ${GRN}✓${RST} $*"; }
warn() { echo -e "  ${YLW}⚠${RST} $*"; }
fail() { echo -e "  ${RED}✗${RST} $*"; exit 1; }
info() { echo -e "  ${CYN}→${RST} $*"; }

compose_cmd() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --project-name "$PROJECT_NAME" "$@"
}

usage() {
  cat <<USAGE
Usage: $0 [options]

Options:
  --apply        Apply the update (default: dry-run)
  --tag <tag>    Image tag to pull (default: latest)
  --rollback     Rollback to previous backup
  -h, --help     Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)    APPLY=true; shift ;;
    --tag)      IMAGE_TAG="$2"; shift 2 ;;
    --rollback) ROLLBACK=true; shift ;;
    -h|--help)  usage; exit 0 ;;
    *)          echo "Unknown: $1"; usage; exit 1 ;;
  esac
done

IMAGES=(
  "${GHCR_REGISTRY}/${GHCR_NAMESPACE}/api:${IMAGE_TAG}"
  "${GHCR_REGISTRY}/${GHCR_NAMESPACE}/web:${IMAGE_TAG}"
  "${GHCR_REGISTRY}/${GHCR_NAMESPACE}/sfu:${IMAGE_TAG}"
)

if [[ "$ROLLBACK" == "true" ]]; then
  echo ""
  echo -e "${BLD}Seclettr Rollback${RST}"
  echo ""

  LATEST_BACKUP=$(ls -d "${COMPOSE_DIR}/backups/ghcr-update-"* 2>/dev/null | sort -r | head -1)
  if [[ -z "$LATEST_BACKUP" ]]; then
    fail "No backups found in ${COMPOSE_DIR}/backups/"
  fi

  info "Latest backup: $(basename "$LATEST_BACKUP")"
  if [[ "$APPLY" != "true" ]]; then
    info "Run with --apply to rollback"
    exit 0
  fi

  if [[ -f "$LATEST_BACKUP/postgres.sql.gz" ]]; then
    info "Restoring database from backup..."
    gunzip < "$LATEST_BACKUP/postgres.sql.gz" | \
      docker exec -i "${PROJECT_NAME}-postgres-1" psql -U seclettr -d seclettr && \
      ok "Database restored" || warn "Database restore had issues"
  fi

  ok "Rollback prepared — restart the previous stack manually"
  echo ""
  echo "  docker compose -f $COMPOSE_FILE --project-name $PROJECT_NAME up -d"
  exit 0
fi

echo ""
echo -e "${BLD}Seclettr GHCR Update${RST}"
echo -e "  Tag:    ${CYN}${IMAGE_TAG}${RST}"
echo -e "  Images:"
for img in "${IMAGES[@]}"; do echo "    ${DIM}${img}${RST}"; done
echo ""

# ── 1. Pull images ────────────────────────────────────────────────────
info "Pulling images..."
for img in "${IMAGES[@]}"; do
  docker pull "$img" 2>&1 | tail -1 || warn "Failed to pull $img"
done
ok "Images pulled"

# ── 2. Check compose + env ────────────────────────────────────────────
if [[ ! -f "$COMPOSE_FILE" ]]; then
  fail "Compose file not found at $COMPOSE_FILE"
fi
if [[ ! -f "$ENV_FILE" ]]; then
  fail "Env file not found at $ENV_FILE"
fi

# ── 3. Check current state ─────────────────────────────────────────────
info "Checking current stack..."
RUNNING=$(docker ps --filter "name=${PROJECT_NAME}-" --format '{{.Names}}' | wc -l)
if [[ "$RUNNING" -eq 0 ]]; then
  warn "No running services found. Doing a fresh deploy instead of update."
fi

# ── 4. Backup DB ───────────────────────────────────────────────────────
if [[ "$APPLY" != "true" ]]; then
  info "Dry-run — use --apply to execute"
  info "Would create backup at: ${BACKUP_DIR}"
  info "Would run the canonical migrate service and restart stack"
  exit 0
fi

mkdir -p "$BACKUP_DIR"
info "Backing up database to ${BACKUP_DIR}/postgres.sql.gz..."
compose_cmd exec -T postgres pg_dump -U seclettr seclettr 2>/dev/null | \
  gzip > "$BACKUP_DIR/postgres.sql.gz" && \
  ok "Database backup saved ($(wc -c < "$BACKUP_DIR/postgres.sql.gz") bytes)" || \
  warn "Backup failed, continuing anyway"

# ── 5. Tag GHCR images as local ────────────────────────────────────────
info "Tagging GHCR images..."
docker tag "${GHCR_REGISTRY}/${GHCR_NAMESPACE}/api:${IMAGE_TAG}" "seclettr/api:release"
docker tag "${GHCR_REGISTRY}/${GHCR_NAMESPACE}/web:${IMAGE_TAG}" "seclettr/web:release"
docker tag "${GHCR_REGISTRY}/${GHCR_NAMESPACE}/sfu:${IMAGE_TAG}" "seclettr/sfu:release"
ok "Images tagged as seclettr/*:release"

# ── 6. Run migrations ──────────────────────────────────────────────────
info "Running canonical migrate service..."
compose_cmd --profile ops run --rm migrate
ok "Migrations applied via canonical runner"

# ── 7. Restart stack ───────────────────────────────────────────────────
info "Restarting stack with new images..."
compose_cmd up -d --remove-orphans 2>&1 | tail -3
ok "Stack restarted"

# ── 8. Health check ────────────────────────────────────────────────────
info "Waiting for API to become healthy..."
for i in $(seq 1 30); do
  sleep 2
  HEALTH=$(compose_cmd exec -T api wget -qO- http://127.0.0.1:3001/health 2>/dev/null || true)
  if echo "$HEALTH" | grep -q '"status":"ok"'; then
    ok "API is healthy"
    break
  fi
  if [[ "$i" -eq 30 ]]; then
    compose_cmd logs --tail 50 api || true
    fail "API did not become healthy after 60s"
  fi
done

echo ""
echo -e "${BLD}Update complete${RST}"
echo ""
echo "  Backup:     $BACKUP_DIR"
echo "  Images:     ghcr.io/${GHCR_NAMESPACE}/*:${IMAGE_TAG}"
echo ""
echo "  Rollback:   $0 --rollback --apply"
echo ""
