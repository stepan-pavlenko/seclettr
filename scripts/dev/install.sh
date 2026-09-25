#!/usr/bin/env bash
set -euo pipefail

_sc="$(readlink -f "${BASH_SOURCE[0]}")" && SCRIPT_DIR="$(cd -- "$(dirname -- "$_sc")/.." && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

NODE_MAJOR=22
INSTALL_PLAYWRIGHT=true
INSTALL_WORKSPACE=true
APT_UPDATED=false
DOCKER_GROUP_CHANGED=false
APT_GET_OPTS=(-o Acquire::ForceIPv4=true)

usage() {
  cat <<'USAGE'
Usage: ./scripts/dev-install.sh [options]

Installs the local development toolchain for Ubuntu/Debian:
  - Docker Engine + Docker Compose plugin
  - Node.js
  - pnpm via corepack
  - build/debug utilities
  - workspace dependencies
  - Playwright Chromium (optional)

Options:
  --node-major <version>   Node.js major version to install if missing (default: 22)
  --skip-playwright        Skip Playwright browser installation
  --skip-workspace         Skip `pnpm install --frozen-lockfile`
  -h, --help               Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node-major)
      NODE_MAJOR="$2"
      shift 2
      ;;
    --skip-playwright)
      INSTALL_PLAYWRIGHT=false
      shift
      ;;
    --skip-workspace)
      INSTALL_WORKSPACE=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

ensure_linux_debian() {
  [[ "$(uname -s)" == "Linux" ]] || die "This installer currently supports Linux only."
  [[ -f /etc/os-release ]] || die "Cannot detect OS metadata."

  # shellcheck disable=SC1091
  source /etc/os-release
  export DISTRO_ID="${ID:-}"
  export DISTRO_CODENAME="${VERSION_CODENAME:-}"

  [[ "$DISTRO_ID" == "ubuntu" || "$DISTRO_ID" == "debian" || "${ID_LIKE:-}" == *debian* ]] \
    || die "This installer currently supports Ubuntu/Debian only."
}

apt_update_once() {
  if [[ "$APT_UPDATED" == "false" ]]; then
    log_step "Running apt-get update"
    run_as_root apt-get "${APT_GET_OPTS[@]}" update
    APT_UPDATED=true
  fi
}

apt_install() {
  local packages=("$@")
  [[ ${#packages[@]} -gt 0 ]] || return 0
  apt_update_once
  log_step "Installing apt packages: ${packages[*]}"
  run_as_root env DEBIAN_FRONTEND=noninteractive apt-get "${APT_GET_OPTS[@]}" install -y "${packages[@]}"
}

ensure_base_packages() {
  apt_install \
    ca-certificates \
    curl \
    git \
    gnupg \
    lsb-release \
    jq \
    ripgrep \
    build-essential \
    pkg-config \
    python3 \
    make \
    g++ \
    unzip \
    xz-utils \
    postgresql-client \
    redis-tools \
    mkcert \
    libnss3-tools
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log_ok "Docker is already available"
  else
    log_step "Installing Docker Engine and Compose plugin"
    apt_install ca-certificates curl gnupg lsb-release

    run_as_root install -m 0755 -d /etc/apt/keyrings
    if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
      curl -fsSL "https://download.docker.com/linux/${DISTRO_ID}/gpg" | run_as_root gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      run_as_root chmod a+r /etc/apt/keyrings/docker.gpg
    fi

    local arch
    arch="$(dpkg --print-architecture)"
    [[ -n "$DISTRO_CODENAME" ]] || die "Unable to determine distribution codename for Docker repository."

    echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${DISTRO_ID} ${DISTRO_CODENAME} stable" \
      | run_as_root tee /etc/apt/sources.list.d/docker.list >/dev/null
    APT_UPDATED=false

    apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

    if command -v systemctl >/dev/null 2>&1; then
      run_as_root systemctl enable --now docker >/dev/null 2>&1 || true
    fi
  fi

  if ! id -nG "$USER" | grep -qw docker; then
    log_step "Adding $USER to the docker group"
    run_as_root usermod -aG docker "$USER"
    DOCKER_GROUP_CHANGED=true
  fi
}

ensure_node() {
  local current_major=""
  if command -v node >/dev/null 2>&1; then
    current_major="$(node -p 'process.versions.node.split(".")[0]')"
  fi

  if [[ -n "$current_major" && "$current_major" -ge "$NODE_MAJOR" ]]; then
    log_ok "Node.js $(node -v) is already available"
    return
  fi

  log_step "Installing Node.js ${NODE_MAJOR}.x"
  run_as_root install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/nodesource.gpg ]]; then
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | run_as_root gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    run_as_root chmod a+r /etc/apt/keyrings/nodesource.gpg
  fi
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    | run_as_root tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  APT_UPDATED=false
  apt_install nodejs
}

ensure_pnpm() {
  require_command corepack
  log_step "Enabling corepack and pnpm"
  corepack enable
  local pnpm_version
  pnpm_version="$(node -p "require('${ROOT_DIR}/package.json').packageManager.split('@').pop()" 2>/dev/null || true)"
  if [[ -z "$pnpm_version" ]]; then
    pnpm_version="11.4.0"
  fi
  corepack prepare "pnpm@${pnpm_version}" --activate
  require_command pnpm
}

verify_node_resolution() {
  local current_major
  current_major="$(node -p 'process.versions.node.split(".")[0]')"

  if [[ "$current_major" -lt "$NODE_MAJOR" ]]; then
    log_warn "Node.js ${NODE_MAJOR}.x was installed, but the current shell still resolves $(command -v node) -> $(node -v). Adjust PATH or remove the older Node binary."
  fi
}

install_workspace() {
  if [[ "$INSTALL_WORKSPACE" == "false" ]]; then
    log_warn "Skipping workspace install by request"
    return
  fi

  log_step "Installing workspace dependencies"
  cd "$ROOT_DIR"
  pnpm install --frozen-lockfile
}

install_playwright() {
  if [[ "$INSTALL_PLAYWRIGHT" == "false" ]]; then
    log_warn "Skipping Playwright browser install by request"
    return
  fi

  log_step "Installing Playwright Chromium and system browser deps"
  cd "$ROOT_DIR"
  pnpm exec playwright install --with-deps chromium
}

ensure_linux_debian
ensure_base_packages
ensure_docker
ensure_node
ensure_pnpm
verify_node_resolution
install_workspace
install_playwright

log_ok "Development toolchain is installed"
echo "  node:    $(node -v)"
echo "  pnpm:    $(pnpm -v)"
echo "  docker:  $(docker --version)"
echo "  compose: $(docker compose version | head -n 1)"

if [[ "$DOCKER_GROUP_CHANGED" == "true" ]]; then
  log_warn "Docker group membership changed. Open a new shell or run 'newgrp docker' before using docker without sudo."
fi
