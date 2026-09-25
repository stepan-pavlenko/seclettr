#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"

COMPOSE_BASE_FILE="$INFRA_DIR/docker-compose.yml"
COMPOSE_DEV_FILE="$INFRA_DIR/docker-compose.dev.yml"
COMPOSE_DEV_LAN_FILE="$INFRA_DIR/docker-compose.dev-lan.yml"
DEFAULT_DEV_ENV_FILE="$INFRA_DIR/.env.dev"
DEFAULT_DEV_ENV_TEMPLATE="$INFRA_DIR/.env.dev.example"

RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[0;33m'
CYN='\033[0;36m'
RST='\033[0m'

DOCKER_CMD=(docker)
SUDO_CMD=(sudo)

if [[ -z "${SUDO_ASKPASS:-}" && -x "$HOME/.local/bin/codex-sudo-askpass" ]]; then
  export SUDO_ASKPASS="$HOME/.local/bin/codex-sudo-askpass"
fi

if [[ -n "${SUDO_ASKPASS:-}" ]]; then
  SUDO_CMD=(sudo -A)
fi

log_step() {
  echo -e "${CYN}==>${RST} $*"
}

log_ok() {
  echo -e "${GRN}OK${RST}  $*"
}

log_warn() {
  echo -e "${YLW}WARN${RST} $*"
}

die() {
  echo -e "${RED}ERR${RST} $*" >&2
  exit 1
}

require_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || die "Missing required command: $command_name"
}

run_as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
    return
  fi

  command -v sudo >/dev/null 2>&1 || die "sudo is required to run: $*"
  "${SUDO_CMD[@]}" "$@"
}

create_env_file_if_missing() {
  local env_file="$1"
  local template_file="$2"

  if [[ -f "$env_file" ]]; then
    return
  fi

  [[ -f "$template_file" ]] || die "Template file not found: $template_file"
  cp "$template_file" "$env_file"
  log_warn "Created $env_file from template. Review secrets and ports if needed."
}

load_env_file() {
  local env_file="$1"

  [[ -f "$env_file" ]] || die "Environment file not found: $env_file"

  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
}

resolve_docker_cmd() {
  if docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    DOCKER_CMD=(docker)
    return
  fi

  if command -v sudo >/dev/null 2>&1 && "${SUDO_CMD[@]}" docker compose version >/dev/null 2>&1 && "${SUDO_CMD[@]}" docker info >/dev/null 2>&1; then
    DOCKER_CMD=("${SUDO_CMD[@]}" docker)
    log_warn "Using sudo for Docker commands because direct docker access is not available in this shell."
    return
  fi

  die "Docker Compose is required and must be accessible to the current user."
}

docker_cli() {
  "${DOCKER_CMD[@]}" "$@"
}

docker_compose() {
  "${DOCKER_CMD[@]}" compose "$@"
}

compose_dev() {
  local project_name="$1"
  local env_file="$2"
  shift 2

  docker_compose \
    -p "$project_name" \
    -f "$COMPOSE_BASE_FILE" \
    -f "$COMPOSE_DEV_FILE" \
    --profile dev-turn \
    --profile dev-web \
    --env-file "$env_file" \
    "$@"
}

compose_dev_lan() {
  local project_name="$1"
  local env_file="$2"
  shift 2

  docker_compose \
    -p "$project_name" \
    -f "$COMPOSE_BASE_FILE" \
    -f "$COMPOSE_DEV_LAN_FILE" \
    --profile dev-turn \
    --profile dev-web \
    --env-file "$env_file" \
    "$@"
}

wait_for_tcp() {
  local host="$1"
  local port="$2"
  local label="$3"
  local attempts="${4:-60}"
  local delay_sec="${5:-1}"

  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if (echo >"/dev/tcp/$host/$port") >/dev/null 2>&1; then
      log_ok "$label is reachable on $host:$port"
      return 0
    fi
    sleep "$delay_sec"
  done

  die "Timed out waiting for $label on $host:$port"
}

port_in_use() {
  local port="$1"
  ss -H -ltnu "sport = :$port" 2>/dev/null | grep -q .
}

port_owner() {
  local port="$1"
  # Try ss with process info first (requires root or own processes)
  local owner
  owner=$(ss -H -ltunp "sport = :$port" 2>/dev/null | awk '{print $NF}' | grep -oP 'pid=\K[0-9]+' | head -1)
  if [[ -n "$owner" ]]; then
    ps -p "$owner" -o comm= 2>/dev/null || echo "pid $owner"
  else
    echo "(run ss -ltunp or lsof -i :$port to see owner)"
  fi
}

ensure_port_available() {
  local port="$1"
  local label="$2"

  if port_in_use "$port"; then
    die "$label port $port is already in use — owner: $(port_owner "$port")"
  fi
}

ensure_port_range_available() {
  local start_port="$1"
  local end_port="$2"
  local label="$3"

  local port
  for ((port = start_port; port <= end_port; port += 1)); do
    if port_in_use "$port"; then
      die "$label port range is not free: $port is already in use"
    fi
  done
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local insecure="${3:-false}"
  local attempts="${4:-60}"
  local delay_sec="${5:-1}"

  require_command curl

  local curl_args=(-fsS)
  if [[ "$insecure" == "true" ]]; then
    curl_args+=(-k)
  fi

  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl "${curl_args[@]}" "$url" >/dev/null 2>&1; then
      log_ok "$label is reachable at $url"
      return 0
    fi
    sleep "$delay_sec"
  done

  die "Timed out waiting for $label at $url"
}

hash_file() {
  local file_path="$1"

  # Write the checksum with a basename (not an absolute build-host path) so
  # `sha256sum -c <archive>.sha256` works on the operator's machine after the
  # bundle is downloaded to a different directory.
  local dir
  local base
  dir="$(cd -- "$(dirname -- "$file_path")" && pwd)"
  base="$(basename -- "$file_path")"

  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$dir" && sha256sum "$base") >"${file_path}.sha256"
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    (cd "$dir" && shasum -a 256 "$base") >"${file_path}.sha256"
  fi
}

run_with_retries() {
  local attempts="$1"
  local delay_sec="$2"
  shift 2

  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if "$@"; then
      return 0
    fi

    if [[ "$attempt" -eq "$attempts" ]]; then
      return 1
    fi

    log_warn "Command failed (attempt ${attempt}/${attempts}): $*"
    log_warn "Retrying in ${delay_sec}s..."
    sleep "$delay_sec"
  done
}
