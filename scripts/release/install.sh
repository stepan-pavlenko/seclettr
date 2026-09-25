#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_DIR="$SCRIPT_DIR"
COMPOSE_FILE="$BUNDLE_DIR/docker-compose.yml"
HTTP_OVERRIDE_FILE="$BUNDLE_DIR/docker-compose.http.yml"
ENV_FILE="$BUNDLE_DIR/.env"
ENV_TEMPLATE="$BUNDLE_DIR/.env.example"
RELEASE_ENV_FILE="$BUNDLE_DIR/release.env"
IMAGE_ARCHIVE="$BUNDLE_DIR/prebuilt-images.tar.gz"
RUNTIME_CONFIG_FILE="$BUNDLE_DIR/nginx/runtime-config.js"
PROJECT_NAME="seclettr"
GITHUB_REPO="stepan-pavlenko/seclettr"
SKIP_LOAD=false
SKIP_MIGRATE=false
SKIP_BACKUP=false
ACTION="install"
CLI_UPDATE_FROM=""
CLI_UPDATE_ARCHIVE=""
PREVIOUS_BUNDLE_DIR=""
BACKUP_DIR=""

CLI_DEPLOY_MODE=""
CLI_NETWORK_MODE=""
CLI_WEB_RUNTIME_API_URL=""
CLI_WEB_RUNTIME_SFU_URL=""
INTERACTIVE_MODE="auto"
SETUP_DOMAIN=""

DEPLOY_MODE=""
NETWORK_MODE=""
WEB_RUNTIME_API_URL=""
WEB_RUNTIME_SFU_URL=""

UI_BACKEND="none"
CERT_MODE=""
LETSENCRYPT_EMAIL=""
CLI_CERT_MODE=""
CLI_LETSENCRYPT_EMAIL=""

ALL_SERVICES=(postgres redis minio minio-init coturn api sfu web)
SELECTED_SERVICES=()
EXCLUDED_SERVICES=()

RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[0;33m'
CYN='\033[0;36m'
BLD='\033[1m'
DIM='\033[2m'
RST='\033[0m'

# ── Progress tracking ──────────────────────────────────────────────────────────
_TOTAL_STEPS=8
_CURRENT_STEP=0

step() {
  _CURRENT_STEP=$(( _CURRENT_STEP + 1 ))
  local label="$*"
  echo -e ""
  echo -e "${CYN}${BLD}  [$_CURRENT_STEP/$_TOTAL_STEPS]${RST}${BLD} ${label}${RST}"
}

# Run a command with a spinner; suppress its stdout/stderr unless it fails.
run_quiet() {
  local label="$1"; shift
  local tmpout
  tmpout="$(mktemp)"
  local spin_chars=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  local spin_idx=0

  printf "       %s %s" "${spin_chars[0]}" "$label"

  "$@" >"$tmpout" 2>&1 &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r       %s %s" "${spin_chars[$spin_idx]}" "$label"
    spin_idx=$(( (spin_idx + 1) % ${#spin_chars[@]} ))
    sleep 0.12
  done
  local rc=0
  set +e
  wait "$pid"
  rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    printf "\r       ${GRN}✓${RST} %s\n" "$label"
  else
    printf "\r       ${RED}✗${RST} %s\n" "$label"
    echo -e "${RED}--- output ---${RST}"
    cat "$tmpout" >&2
    echo -e "${RED}--------------${RST}"
  fi
  rm -f "$tmpout"
  return $rc
}

DOCKER_CMD=(docker)
SUDO_CMD=(sudo)

if [[ -z "${SUDO_ASKPASS:-}" && -x "$HOME/.local/bin/codex-sudo-askpass" ]]; then
  export SUDO_ASKPASS="$HOME/.local/bin/codex-sudo-askpass"
fi

if [[ -n "${SUDO_ASKPASS:-}" ]]; then
  SUDO_CMD=(sudo -A)
fi

usage() {
  cat <<'USAGE'
Usage: ./install.sh [install|update] [options]

Loads a Seclettr release bundle and starts one of the supported deployment modes.

Recommended update flows:
  # From the currently running/old release directory:
  ./install.sh update /opt/seclettr-release-NEW.tar.gz
  ./install.sh update /opt/seclettr-release-NEW

  # From an already unpacked new release directory:
  ./install.sh update --from /opt/seclettr-release-OLD

Deployment modes:
  full      Web + backend + infra services
  backend   Backend + infra services (no web frontend)
  web       Web frontend only (for external backend)

Network modes:
  tls       HTTPS (nginx.conf, requires cert.pem/key.pem)
  http      HTTP only (nginx.http.conf)

Options:
  --mode <full|backend|web>           Deployment mode (default: full)
  --network <tls|http>                Frontend network mode (default: derived from NGINX_CONFIG)
  --cert-mode <selfsigned|letsencrypt> TLS certificate source (default: prompt or selfsigned)
  --letsencrypt-email <email>         Contact email for Let's Encrypt expiry alerts (optional)
  --web-api-url <value>               Runtime API URL for web app (default: /api)
  --web-sfu-url <value>               Runtime SFU URL for web app (default: /sfu)
  --interactive                       Force pseudo-graphic/text installer prompts
  --non-interactive                   Disable prompts (CI/automation mode)
  --env-file <path>                   Path to runtime .env file (default: ./.env)
  --compose-file <path>               Path to compose file (default: ./docker-compose.yml)
  --image-archive <path>              Path to image archive (default: ./prebuilt-images.tar.gz)
  --project-name <name>               Docker Compose project name (default: seclettr)
  --update [archive-or-dir]           Update. Accepts a new release .tar.gz or unpacked release directory
  --from <path>                       Previous release bundle directory when running from the new bundle
  --skip-load                         Skip `docker load`
  --skip-migrate                      Skip migration step
  --skip-backup                       Skip update backup step
  -h, --help                          Show this help
USAGE
}

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

web_probe_url() {
  if [[ "$NETWORK_MODE" == "http" ]]; then
    printf 'http://127.0.0.1:%s/runtime-config.js' "${WEB_HTTP_PORT:-80}"
  else
    printf 'https://127.0.0.1:%s/runtime-config.js' "${WEB_HTTPS_PORT:-443}"
  fi
}

verify_web_reachability() {
  local url
  url="$(web_probe_url)"
  local -a curl_args=(-fsS)
  if [[ "$NETWORK_MODE" != "http" ]]; then
    curl_args+=(-k)
  fi

  for attempt in $(seq 1 30); do
    if curl "${curl_args[@]}" "$url" 2>/dev/null | grep -q '__SECLETTR_RUNTIME_CONFIG__'; then
      log_ok "Web probe succeeded: $url"
      return 0
    fi
    sleep 2
  done

  die "Web probe failed: $url"
}

require_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || die "Missing required command: $command_name"
}

# ── System dependency bootstrap ────────────────────────────────────────────────

_detect_pkg_manager() {
  if command -v apt-get >/dev/null 2>&1; then echo "apt"
  elif command -v dnf >/dev/null 2>&1; then echo "dnf"
  elif command -v yum >/dev/null 2>&1; then echo "yum"
  elif command -v apk >/dev/null 2>&1; then echo "apk"
  else echo "unknown"
  fi
}

_install_docker() {
  local pm="$(_detect_pkg_manager)"
  case "$pm" in
    apt)
      log_step "Installing Docker (apt)..."
      apt-get update -qq
      apt-get install -y -qq ca-certificates curl gnupg lsb-release
      install -m 0755 -d /etc/apt/keyrings
      local distro_id; distro_id="$(. /etc/os-release && echo "$ID")"
      curl -fsSL "https://download.docker.com/linux/${distro_id}/gpg" \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      chmod a+r /etc/apt/keyrings/docker.gpg
      local arch codename
      arch="$(dpkg --print-architecture)"
      codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
      echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/${distro_id} ${codename} stable" \
        > /etc/apt/sources.list.d/docker.list
      apt-get update -qq
      apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    dnf)
      log_step "Installing Docker (dnf)..."
      dnf -y -q install dnf-plugins-core
      dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
      dnf -y -q install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    yum)
      log_step "Installing Docker (yum)..."
      yum install -y -q yum-utils
      yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
      yum install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    apk)
      log_step "Installing Docker (apk)..."
      apk add --quiet docker docker-cli-compose
      ;;
    *)
      die "Docker is not installed. Install it manually: https://docs.docker.com/engine/install/"
      ;;
  esac
  systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true
  log_ok "Docker installed"
}

_install_pkg() {
  local name="$1"; shift
  local pm="$(_detect_pkg_manager)"
  case "$pm" in
    apt) apt-get install -y -qq "$@" ;;
    dnf) dnf install -y -q "$@" ;;
    yum) yum install -y -q "$@" ;;
    apk) apk add --quiet "$@" ;;
    *)   log_warn "Cannot install $name automatically — install it manually if needed" ;;
  esac
}

ensure_system_deps() {
  # Only auto-install if running as root; otherwise just check and warn
  local is_root=false
  [[ "$(id -u)" -eq 0 ]] && is_root=true

  # Docker
  if ! docker compose version >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    if [[ "$is_root" == "true" ]]; then
      _install_docker
    else
      die "Docker is not running or not installed. Install it first: https://docs.docker.com/engine/install/"
    fi
  fi

  # curl + openssl
  local missing_basics=()
  for cmd in curl openssl; do
    command -v "$cmd" >/dev/null 2>&1 || missing_basics+=("$cmd")
  done
  if [[ ${#missing_basics[@]} -gt 0 && "$is_root" == "true" ]]; then
    log_step "Installing basic utilities: ${missing_basics[*]}"
    _install_pkg "basics" "${missing_basics[@]}"
  fi

  # whiptail — best-effort, fall back to text prompts silently
  if ! command -v whiptail >/dev/null 2>&1 && [[ "$is_root" == "true" ]]; then
    local pm; pm="$(_detect_pkg_manager)"
    case "$pm" in
      apt) apt-get install -y -qq whiptail 2>/dev/null || true ;;
      dnf) dnf install -y -q newt 2>/dev/null || true ;;
      yum) yum install -y -q newt 2>/dev/null || true ;;
      apk) apk add --quiet newt 2>/dev/null || true ;;
    esac
  fi

  # cron — best-effort, only needed for cert auto-renewal
  if ! command -v crontab >/dev/null 2>&1 && [[ "$is_root" == "true" ]]; then
    local pm; pm="$(_detect_pkg_manager)"
    case "$pm" in
      apt) apt-get install -y -qq cron 2>/dev/null && systemctl enable --now cron 2>/dev/null || true ;;
      dnf) dnf install -y -q cronie 2>/dev/null && systemctl enable --now crond 2>/dev/null || true ;;
      yum) yum install -y -q cronie 2>/dev/null && systemctl enable --now crond 2>/dev/null || true ;;
      apk) apk add --quiet dcron 2>/dev/null && rc-update add dcron default 2>/dev/null || true ;;
    esac
  fi
}

gen_secret_hex() {
  openssl rand -hex "${1:-32}"
}

detect_public_ip() {
  local ip
  local url
  for url in "https://api.ipify.org" "https://checkip.amazonaws.com" "https://ifconfig.me"; do
    ip="$(curl -s --connect-timeout 5 "$url" 2>/dev/null | tr -d '[:space:]')" || continue
    if [[ "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
      printf '%s' "$ip"
      return
    fi
  done
}

gen_vapid_keys() {
  # Method 1: Node.js — most reliable, produces exact VAPID format
  if command -v node >/dev/null 2>&1; then
    local _out
    _out="$(node - 2>/dev/null <<'NODE_SCRIPT'
const { createECDH } = require("node:crypto");
const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const ec = createECDH("prime256v1");
ec.generateKeys();
// uncompressed public key (65 bytes, starts with 0x04) + raw private key (32 bytes)
console.log(b64u(ec.getPublicKey(null,"uncompressed")));
console.log(b64u(ec.getPrivateKey()));
NODE_SCRIPT
    )" || _out=""
    if [[ "$(echo "$_out" | wc -l)" -ge 2 ]]; then
      printf '%s' "$_out"
      return 0
    fi
  fi

  # Method 2: Python 3 — present on virtually every Linux server
  local _py
  for _py in python3 python; do
    command -v "$_py" >/dev/null 2>&1 || continue
    local _out
    _out="$("$_py" - 2>/dev/null <<'PYEOF'
import base64, os
try:
    from cryptography.hazmat.primitives.asymmetric.ec import generate_private_key, SECP256R1, EllipticCurvePublicKey
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    key = generate_private_key(SECP256R1(), default_backend())
    pub_bytes = key.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    priv_bytes = key.private_numbers().private_value.to_bytes(32, "big")
    b64u = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
    print(b64u(pub_bytes))
    print(b64u(priv_bytes))
except Exception:
    pass
PYEOF
    )" || _out=""
    if [[ "$(echo "$_out" | wc -l)" -ge 2 && -n "$_out" ]]; then
      printf '%s' "$_out"
      return 0
    fi
    break
  done

  # Method 3: openssl — parse DER output carefully
  if command -v openssl >/dev/null 2>&1; then
    local _tmp _pub64 _priv64
    _tmp="$(mktemp)"
    openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$_tmp" 2>/dev/null || {
      rm -f "$_tmp"; printf '\n'; return 1
    }
    # Public key: SubjectPublicKeyInfo DER ends with 65-byte uncompressed point
    _pub64="$(openssl pkey -in "$_tmp" -pubout -outform DER 2>/dev/null \
      | dd bs=1 skip=27 2>/dev/null | base64 -w0 | tr '+/' '-_' | tr -d '=')"
    # Private key: ECPrivateKey DER has 32-byte scalar at offset 7
    _priv64="$(openssl pkey -in "$_tmp" -outform DER 2>/dev/null \
      | dd bs=1 skip=7 count=32 2>/dev/null | base64 -w0 | tr '+/' '-_' | tr -d '=')"
    rm -f "$_tmp"
    # Validate lengths: pub=87 chars (65 bytes b64url), priv=43 chars (32 bytes b64url)
    if [[ ${#_pub64} -eq 87 && ${#_priv64} -eq 43 ]]; then
      printf '%s\n%s' "$_pub64" "$_priv64"
      return 0
    fi
  fi

  # Nothing worked — push notifications will be disabled; warn loudly
  log_warn "Could not generate VAPID keys (no node/python3/openssl available)."
  log_warn "Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY manually in .env to enable push notifications."
  printf '\n'
  return 0
}

fetch_latest_release_archive() {
  # Downloads the latest GitHub release bundle into $BUNDLE_DIR/.. and returns
  # the path to the .tar.gz on stdout.  Dies on network or integrity errors.
  local repo="${GITHUB_REPO}"
  local dest_dir
  dest_dir="$(cd "$BUNDLE_DIR/.." && pwd)"

  log_step "Fetching latest release info from GitHub..."
  command -v curl >/dev/null 2>&1 || die "curl is required to auto-fetch the latest release. Install it or download the bundle manually."

  local release_json
  release_json="$(curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${repo}/releases" \
    | grep -o '"browser_download_url":"[^"]*"' | head -40)"

  local asset_url="" checksum_url=""
  while IFS= read -r line; do
    local url="${line#*:\"}"
    url="${url%\"}"
    if [[ "$url" == *seclettr-release-*.tar.gz && "$url" != *.sha256 && -z "$asset_url" ]]; then
      asset_url="$url"
    fi
    if [[ "$url" == *.tar.gz.sha256 && -z "$checksum_url" ]]; then
      checksum_url="$url"
    fi
  done <<< "$release_json"

  [[ -n "$asset_url" ]] || die "No release bundle found at api.github.com/repos/${repo}/releases. Make sure releases are published."

  local archive_name
  archive_name="$(basename "$asset_url")"
  local archive_path="$dest_dir/$archive_name"

  if [[ -f "$archive_path" ]]; then
    log_ok "Release archive already present: $archive_path"
  else
    log_step "Downloading ${archive_name}..."
    curl -fL --progress-bar -o "$archive_path" "$asset_url"
    echo ""
    log_ok "Downloaded: $archive_path"
  fi

  if [[ -n "$checksum_url" ]]; then
    log_step "Verifying integrity..."
    local checksum_file="$dest_dir/${archive_name}.sha256"
    curl -fsSL -o "$checksum_file" "$checksum_url"
    local expected actual
    expected="$(awk '{print $1}' "$checksum_file")"
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$archive_path" | awk '{print $1}')"
    else
      actual="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
    fi
    [[ "$actual" == "$expected" ]] || die "Checksum mismatch for $archive_name — the file may be corrupted.
  Expected: $expected
  Actual:   $actual"
    log_ok "Integrity verified"
  else
    log_warn "No checksum file found for $archive_name — skipping integrity check"
  fi

  printf '%s' "$archive_path"
}

fill_env_secrets() {
  local env_file="$1"
  local public_ip="${2:-}"
  local domain="${3:-}"

  local pg_pass redis_pass jwt_secret turn_secret minio_key minio_secret metrics_token
  pg_pass="$(gen_secret_hex 24)"
  redis_pass="$(gen_secret_hex 24)"
  jwt_secret="$(gen_secret_hex 32)"
  turn_secret="$(gen_secret_hex 32)"
  minio_key="$(openssl rand -hex 10 | tr '[:lower:]' '[:upper:]')"
  minio_secret="$(gen_secret_hex 24)"
  metrics_token="$(gen_secret_hex 16)"

  local vapid_pub="" vapid_priv=""
  local vapid_keys
  vapid_keys="$(gen_vapid_keys)"
  vapid_pub="$(echo "$vapid_keys" | head -1)"
  vapid_priv="$(echo "$vapid_keys" | tail -1)"

  local vapid_subject="mailto:admin@localhost"
  if [[ -n "$domain" && "$domain" != "localhost" ]]; then
    vapid_subject="mailto:admin@${domain}"
  fi

  sed -i \
    -e "s|CHANGE_ME_POSTGRES_PASSWORD|${pg_pass}|g" \
    -e "s|CHANGE_ME_REDIS_PASSWORD|${redis_pass}|g" \
    -e "s|CHANGE_ME_JWT_SECRET_MIN_32_CHARS|${jwt_secret}|g" \
    -e "s|CHANGE_ME_TURN_SECRET|${turn_secret}|g" \
    -e "s|CHANGE_ME_MINIO_ACCESS_KEY|${minio_key}|g" \
    -e "s|CHANGE_ME_MINIO_SECRET|${minio_secret}|g" \
    -e "s|CHANGE_ME_METRICS_BEARER_TOKEN|${metrics_token}|g" \
    -e "s|CHANGE_ME_VAPID_PUBLIC_KEY|${vapid_pub}|g" \
    -e "s|CHANGE_ME_VAPID_PRIVATE_KEY|${vapid_priv}|g" \
    -e "s|CHANGE_ME_VAPID_SUBJECT|${vapid_subject}|g" \
    "$env_file"

  if [[ -n "$public_ip" ]]; then
    sed -i \
      -e "s|^TURN_EXTERNAL_IP=.*|TURN_EXTERNAL_IP=${public_ip}|" \
      -e "s|^ANNOUNCED_IP=.*|ANNOUNCED_IP=${public_ip}|" \
      "$env_file"
  fi

  if [[ -n "$domain" ]]; then
    sed -i \
      -e "s|^TURN_DOMAIN=.*|TURN_DOMAIN=${domain}|" \
      -e "s|^CORS_ORIGIN=.*|CORS_ORIGIN=https://${domain}|" \
      "$env_file"
  elif [[ -n "$public_ip" ]]; then
    sed -i \
      -e "s|^TURN_DOMAIN=.*|TURN_DOMAIN=${public_ip}|" \
      -e "s|^CORS_ORIGIN=.*|CORS_ORIGIN=https://${public_ip}|" \
      "$env_file"
  fi
}

gen_self_signed_cert() {
  local cert_dir="$1"
  local domain="${2:-localhost}"
  local ip="${3:-}"

  require_command openssl
  mkdir -p "$cert_dir"

  local san="DNS:${domain},DNS:localhost,IP:127.0.0.1"
  if [[ -n "$ip" && "$ip" != "127.0.0.1" ]]; then
    san="${san},IP:${ip}"
  fi

  local cfg
  cfg="$(mktemp)"
  cat >"$cfg" <<OPENSSL_CFG
[req]
distinguished_name = req_dn
x509_extensions    = v3_req
prompt             = no

[req_dn]
CN = ${domain}

[v3_req]
subjectAltName = ${san}
OPENSSL_CFG

  openssl req -x509 -newkey rsa:4096 \
    -keyout "${cert_dir}/key.pem" \
    -out "${cert_dir}/cert.pem" \
    -days 365 -nodes \
    -config "$cfg" \
    2>/dev/null
  rm -f "$cfg"
  chmod 644 "${cert_dir}/key.pem"
}

is_ip_address() {
  [[ "$1" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]
}

require_certbot() {
  if command -v certbot >/dev/null 2>&1; then
    return
  fi
  log_step "certbot not found — installing..."
  if command -v apt-get >/dev/null 2>&1; then
    "${SUDO_CMD[@]}" apt-get install -y certbot >/dev/null \
      || die "Failed to install certbot. Install it manually: https://certbot.eff.org"
  else
    die "certbot is not installed. Install it manually: https://certbot.eff.org"
  fi
}

provision_letsencrypt_cert() {
  local domain="$1"
  local email="$2"
  local cert_dir="$3"

  require_certbot

  # If certbot already has a valid cert for this domain, reuse it directly
  # without running certbot again (avoids port-80 conflicts with running nginx).
  local live_dir="/etc/letsencrypt/live/$domain"
  if [[ -f "$live_dir/fullchain.pem" && -f "$live_dir/privkey.pem" ]]; then
    log_ok "Let's Encrypt certificate already present for $domain — reusing"
    mkdir -p "$cert_dir"
    cp "$live_dir/fullchain.pem" "$cert_dir/cert.pem"
    cp "$live_dir/privkey.pem"  "$cert_dir/key.pem"
    chmod 644 "$cert_dir/key.pem"
    return 0
  fi

  local certbot_args=(certonly --non-interactive --agree-tos -d "$domain")
  if [[ -n "$email" ]]; then
    certbot_args+=(--email "$email")
  else
    certbot_args+=(--register-unsafely-without-email)
  fi

  log_step "Obtaining Let's Encrypt certificate for $domain"

  # Run certbot; allow non-zero exit — we verify success by checking the output files.
  certbot "${certbot_args[@]}" --standalone || true

  if [[ ! -f "$live_dir/fullchain.pem" || ! -f "$live_dir/privkey.pem" ]]; then
    log_warn "certbot did not produce a certificate. If port 80 is in use, free it and re-run install.sh."
    log_warn "Or place your certificate manually in nginx/certs/cert.pem and nginx/certs/key.pem."
    return 1
  fi

  mkdir -p "$cert_dir"
  cp "$live_dir/fullchain.pem" "$cert_dir/cert.pem"
  cp "$live_dir/privkey.pem"  "$cert_dir/key.pem"
  chmod 644 "$cert_dir/key.pem"
  log_ok "Let's Encrypt certificate obtained for $domain"
}

setup_letsencrypt_renewal() {
  local domain="$1"
  local cert_dir="$2"

  local renew_script="$BUNDLE_DIR/renew-cert.sh"
  cat >"$renew_script" <<RENEW_SCRIPT
#!/usr/bin/env bash
set -euo pipefail
docker compose -p ${PROJECT_NAME} --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" stop web 2>/dev/null || true
certbot renew --quiet
cp "/etc/letsencrypt/live/${domain}/fullchain.pem" "${cert_dir}/cert.pem"
cp "/etc/letsencrypt/live/${domain}/privkey.pem" "${cert_dir}/key.pem"
chmod 644 "${cert_dir}/key.pem"
docker compose -p ${PROJECT_NAME} --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" start web
RENEW_SCRIPT
  chmod +x "$renew_script"

  local cron_line="0 3,15 * * * $renew_script >> /var/log/seclettr-cert-renew.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v "renew-cert.sh"; echo "$cron_line" ) | crontab -
  log_ok "Certificate auto-renewal scheduled (cron, twice daily)"
}

choose_cert_mode_interactive() {
  local domain="${TURN_DOMAIN:-}"

  if is_ip_address "$domain" || [[ -z "$domain" || "$domain" == "localhost" ]]; then
    CERT_MODE="selfsigned"
    return
  fi

  if [[ "$UI_BACKEND" == "whiptail" ]]; then
    local le_state="OFF"
    local ss_state="ON"
    [[ "$CERT_MODE" == "letsencrypt" ]] && le_state="ON" && ss_state="OFF"
    CERT_MODE="$({
      whiptail --title "TLS Certificate" --radiolist \
        "How should the TLS certificate be obtained for ${domain}?" 14 72 2 \
        "letsencrypt" "Let's Encrypt — trusted, auto-renewed  [recommended]" "$le_state" \
        "selfsigned"  "Self-signed — browser warning, no DNS required" "$ss_state" \
        3>&1 1>&2 2>&3
    })" || die "Installation cancelled"
    if [[ "$CERT_MODE" == "letsencrypt" ]]; then
      LETSENCRYPT_EMAIL="$({
        whiptail --title "TLS Certificate" --inputbox \
          "Contact email for Let's Encrypt expiry alerts (optional, press Enter to skip):" 10 72 "$LETSENCRYPT_EMAIL" \
          3>&1 1>&2 2>&3
      })" || true
      LETSENCRYPT_EMAIL="$(trim_string "$LETSENCRYPT_EMAIL")"
    fi
    return
  fi

  if [[ "$UI_BACKEND" == "dialog" ]]; then
    local le_state="off"
    local ss_state="on"
    [[ "$CERT_MODE" == "letsencrypt" ]] && le_state="on" && ss_state="off"
    local tmp
    tmp="$(mktemp)"
    dialog --stdout --title "TLS Certificate" --radiolist \
      "How should the TLS certificate be obtained for ${domain}?" 14 72 2 \
      "letsencrypt" "Let's Encrypt — trusted, auto-renewed (recommended)" "$le_state" \
      "selfsigned"  "Self-signed — browser warning, no DNS required" "$ss_state" >"$tmp" \
      || { rm -f "$tmp"; die "Installation cancelled"; }
    CERT_MODE="$(cat "$tmp")"
    rm -f "$tmp"
    if [[ "$CERT_MODE" == "letsencrypt" ]]; then
      tmp="$(mktemp)"
      dialog --stdout --title "TLS Certificate" --inputbox \
        "Contact email for Let's Encrypt expiry alerts (optional, press Enter to skip):" 10 72 "$LETSENCRYPT_EMAIL" >"$tmp" || true
      LETSENCRYPT_EMAIL="$(trim_string "$(cat "$tmp")")"
      rm -f "$tmp"
    fi
    return
  fi

  echo ""
  echo "TLS certificate for domain: $domain"
  echo "  1) Let's Encrypt — trusted, auto-renewed  [recommended]"
  echo "  2) Self-signed    — browser will show a security warning"
  local default_choice="1"
  [[ "$CERT_MODE" == "selfsigned" ]] && default_choice="2"
  local choice
  read -r -p "Select certificate type [1-2] (default: $default_choice): " choice
  choice="$(trim_string "$choice")"
  choice="${choice:-$default_choice}"
  case "$choice" in
    1) CERT_MODE="letsencrypt" ;;
    2) CERT_MODE="selfsigned" ;;
    *) die "Invalid selection: $choice" ;;
  esac
  if [[ "$CERT_MODE" == "letsencrypt" ]]; then
    read -r -p "Contact email for Let's Encrypt (optional, press Enter to skip): " LETSENCRYPT_EMAIL
    LETSENCRYPT_EMAIL="$(trim_string "$LETSENCRYPT_EMAIL")"
  fi
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

docker_compose() {
  local compose_args=(-p "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

  if [[ "$NETWORK_MODE" == "http" && -f "$HTTP_OVERRIDE_FILE" ]]; then
    compose_args+=(-f "$HTTP_OVERRIDE_FILE")
  fi

  "${DOCKER_CMD[@]}" compose "${compose_args[@]}" "$@"
}

create_update_backup() {
  if [[ "$ACTION" != "update" || "$SKIP_BACKUP" == "true" ]]; then
    return
  fi

  BACKUP_DIR="$BUNDLE_DIR/backups/update-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_DIR"

  cp "$ENV_FILE" "$BACKUP_DIR/.env"
  if [[ -d "$BUNDLE_DIR/nginx/certs" ]]; then
    mkdir -p "$BACKUP_DIR/nginx"
    cp -a "$BUNDLE_DIR/nginx/certs" "$BACKUP_DIR/nginx/certs" 2>/dev/null || true
  fi
  if [[ -f "$RUNTIME_CONFIG_FILE" ]]; then
    mkdir -p "$BACKUP_DIR/nginx"
    cp "$RUNTIME_CONFIG_FILE" "$BACKUP_DIR/nginx/runtime-config.js"
  fi

  if is_mode_with_backend; then
    local postgres_running=""
    postgres_running="$(docker_compose ps postgres --status running --format '{{.Name}}' 2>/dev/null || true)"
    if [[ -n "$postgres_running" ]]; then
      if docker_compose exec -T postgres pg_dump -U seclettr seclettr >"$BACKUP_DIR/postgres.sql" 2>"$BACKUP_DIR/postgres.dump.log"; then
        gzip -f "$BACKUP_DIR/postgres.sql"
        rm -f "$BACKUP_DIR/postgres.dump.log"
        log_ok "Database backup saved to $BACKUP_DIR/postgres.sql.gz"
      else
        log_warn "Database backup failed; see $BACKUP_DIR/postgres.dump.log"
        rm -f "$BACKUP_DIR/postgres.sql"
      fi
    else
      log_warn "Postgres container is not running; skipping database dump"
    fi
  fi

  cat >"$BACKUP_DIR/README.txt" <<EOF_BACKUP
Seclettr update backup
Created: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

Contains:
- .env runtime secrets/settings
- nginx/certs if present
- nginx/runtime-config.js if present
- postgres.sql.gz if Postgres was running and pg_dump succeeded

This backup is for rollback assistance. Docker named volumes are kept in place
by the update process unless you explicitly remove them.
EOF_BACKUP

  log_ok "Update backup directory: $BACKUP_DIR"
}

trim_string() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

set_env_value() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
  export "${key}=${value}"
}

read_release_env_value() {
  local key="$1"
  [[ -f "$RELEASE_ENV_FILE" ]] || return 1
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$RELEASE_ENV_FILE"
}

apply_bundle_image_refs() {
  if [[ ! -f "$RELEASE_ENV_FILE" ]]; then
    log_warn "No release.env found in this bundle — keeping SECLETTR_* image refs from $ENV_FILE"
    return 0
  fi

  if [[ "${SECLETTR_PRESERVE_IMAGE_REFS:-false}" == "true" ]]; then
    log_warn "Keeping image refs from $ENV_FILE because SECLETTR_PRESERVE_IMAGE_REFS=true"
    return
  fi

  local bundle_tag bundle_api bundle_web bundle_sfu
  bundle_tag="$(read_release_env_value SECLETTR_IMAGE_TAG || true)"
  bundle_api="$(read_release_env_value SECLETTR_API_IMAGE || true)"
  bundle_web="$(read_release_env_value SECLETTR_WEB_IMAGE || true)"
  bundle_sfu="$(read_release_env_value SECLETTR_SFU_IMAGE || true)"

  [[ -n "$bundle_tag" ]] || die "release.env is missing SECLETTR_IMAGE_TAG"
  [[ -n "$bundle_api" ]] || bundle_api="seclettr/api"
  [[ -n "$bundle_web" ]] || bundle_web="seclettr/web"
  [[ -n "$bundle_sfu" ]] || bundle_sfu="seclettr/sfu"

  set_env_value SECLETTR_IMAGE_TAG "$bundle_tag"
  set_env_value SECLETTR_API_IMAGE "$bundle_api"
  set_env_value SECLETTR_WEB_IMAGE "$bundle_web"
  set_env_value SECLETTR_SFU_IMAGE "$bundle_sfu"

  log_ok "Using bundled Docker image tag: $bundle_tag"
}

sync_s3_public_url() {
  if ! is_mode_with_backend; then
    return 0
  fi

  local public_url="${S3_PUBLIC_URL:-}"
  if [[ -z "$public_url" ]]; then
    public_url="${CORS_ORIGIN:-}"
    # If multiple origins are configured, use the first one as the browser-facing
    # MinIO URL. Advanced deployments can set S3_PUBLIC_URL explicitly.
    public_url="${public_url%%,*}"
  fi

  public_url="$(trim_string "$public_url")"
  if [[ -n "$public_url" ]]; then
    set_env_value S3_PUBLIC_URL "$public_url"
    log_ok "Browser-facing S3 URL: $public_url"
  else
    log_warn "S3_PUBLIC_URL is empty — presigned media URLs may point to the internal MinIO endpoint"
  fi
}

runtime_image_for_service() {
  case "$1" in
    postgres) printf '%s' "postgres:16-alpine" ;;
    redis) printf '%s' "redis:7-alpine" ;;
    minio) printf '%s' "minio/minio:latest" ;;
    minio-init) printf '%s' "minio/mc:latest" ;;
    coturn) printf '%s' "coturn/coturn:latest" ;;
    api|migrate) printf '%s:%s' "${SECLETTR_API_IMAGE:-ghcr.io/stepan-pavlenko/seclettr/api}" "${SECLETTR_IMAGE_TAG:-latest}" ;;
    sfu) printf '%s:%s' "${SECLETTR_SFU_IMAGE:-ghcr.io/stepan-pavlenko/seclettr/sfu}" "${SECLETTR_IMAGE_TAG:-latest}" ;;
    web) printf '%s:%s' "${SECLETTR_WEB_IMAGE:-ghcr.io/stepan-pavlenko/seclettr/web}" "${SECLETTR_IMAGE_TAG:-latest}" ;;
    *) return 1 ;;
  esac
}

validate_runtime_images_available() {
  local images=()
  local service image_ref existing

  for service in "${SELECTED_SERVICES[@]}"; do
    image_ref="$(runtime_image_for_service "$service")" || continue
    images+=("$image_ref")
  done

  if is_mode_with_backend && [[ "$SKIP_MIGRATE" == "false" ]]; then
    images+=("$(runtime_image_for_service migrate)")
  fi

  local unique_images=()
  for image_ref in "${images[@]}"; do
    existing=false
    local current
    for current in "${unique_images[@]}"; do
      [[ "$current" == "$image_ref" ]] && existing=true && break
    done
    [[ "$existing" == "false" ]] && unique_images+=("$image_ref")
  done

  local missing=()
  for image_ref in "${unique_images[@]}"; do
    "${DOCKER_CMD[@]}" image inspect "$image_ref" >/dev/null 2>&1 || missing+=("$image_ref")
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    die "Required Docker image(s) are not available: ${missing[*]}.
  If installing offline: ensure prebuilt-images.tar.gz is present and run: docker load -i prebuilt-images.tar.gz
  If installing online: check your internet connection and run: docker compose pull"
  fi
}

absolute_path() {
  local path="$1"
  if [[ "$path" == /* ]]; then
    printf '%s' "$path"
    return
  fi

  if [[ -e "$path" ]]; then
    printf '%s/%s' "$(pwd)" "$path"
    return
  fi

  if [[ -e "$BUNDLE_DIR/$path" ]]; then
    printf '%s/%s' "$BUNDLE_DIR" "$path"
    return
  fi

  printf '%s/%s' "$(pwd)" "$path"
}

normalize_runtime_url() {
  local value
  value="$(trim_string "$1")"
  while [[ "$value" != "/" && "$value" == */ ]]; do
    value="${value%/}"
  done
  printf '%s' "$value"
}

is_valid_runtime_url() {
  local value="$1"
  [[ "$value" == /* || "$value" =~ ^https?://[^[:space:]]+$ ]]
}

validate_mode() {
  case "$1" in
    full|backend|web) ;;
    *)
      die "Invalid mode '$1'. Use one of: full, backend, web"
      ;;
  esac
}

validate_network_mode() {
  case "$1" in
    tls|http) ;;
    *)
      die "Invalid network mode '$1'. Use one of: tls, http"
      ;;
  esac
}

is_mode_with_backend() {
  [[ "$DEPLOY_MODE" == "full" || "$DEPLOY_MODE" == "backend" ]]
}

is_mode_with_web() {
  [[ "$DEPLOY_MODE" == "full" || "$DEPLOY_MODE" == "web" ]]
}

is_interactive_enabled() {
  case "$INTERACTIVE_MODE" in
    true) return 0 ;;
    false) return 1 ;;
    auto)
      [[ -t 0 && -t 1 ]]
      ;;
    *) return 1 ;;
  esac
}

detect_ui_backend() {
  UI_BACKEND="text"

  if command -v whiptail >/dev/null 2>&1; then
    UI_BACKEND="whiptail"
    return
  fi

  if command -v dialog >/dev/null 2>&1; then
    UI_BACKEND="dialog"
    return
  fi
}

show_welcome_banner() {
  if [[ "$UI_BACKEND" == "whiptail" ]]; then
    whiptail --title "Seclettr Installer" --msgbox \
      "Welcome to the Seclettr Installer!\n\nThis wizard will set up Seclettr on your server.\nSecrets and certificates are generated automatically.\nYou will be asked just a few short questions.\n\nPress Enter to continue." \
      14 64
    return
  fi

  if [[ "$UI_BACKEND" == "dialog" ]]; then
    dialog --title "Seclettr Installer" --msgbox \
      "Welcome to the Seclettr Installer!\n\nThis wizard will set up Seclettr on your server.\nSecrets and certificates are generated automatically.\nYou will be asked just a few short questions." \
      12 64
    return
  fi

  echo ""
  echo -e "${CYN}┌─────────────────────────────────────────┐${RST}"
  echo -e "${CYN}│        Seclettr Installation Wizard      │${RST}"
  echo -e "${CYN}└─────────────────────────────────────────┘${RST}"
  echo ""
  echo "  This wizard will set up Seclettr on your server."
  echo "  Secrets and certificates are generated automatically."
  echo "  You will be asked just a few short questions."
  echo ""
}

choose_mode_interactive() {
  if [[ "$UI_BACKEND" == "whiptail" ]]; then
    local full_state="OFF"
    local backend_state="OFF"
    local web_state="OFF"
    case "$DEPLOY_MODE" in
      full) full_state="ON" ;;
      backend) backend_state="ON" ;;
      web) web_state="ON" ;;
    esac

    DEPLOY_MODE="$({
      whiptail --title "Seclettr Installer" --radiolist \
        "What do you want to deploy on this server?\n(Use arrow keys + Space to select, Enter to confirm)" 18 72 3 \
        "full"    "Everything: web interface + backend + database (recommended)" "$full_state" \
        "backend" "Backend + database only (no web interface)" "$backend_state" \
        "web"     "Web interface only (backend is on another server)" "$web_state" \
        3>&1 1>&2 2>&3
    } )" || die "Installation cancelled"
    return
  fi

  if [[ "$UI_BACKEND" == "dialog" ]]; then
    local full_state="off"
    local backend_state="off"
    local web_state="off"
    case "$DEPLOY_MODE" in
      full) full_state="on" ;;
      backend) backend_state="on" ;;
      web) web_state="on" ;;
    esac

    local choice_file
    choice_file="$(mktemp)"
    dialog --stdout --title "Seclettr Installer" --radiolist \
      "What do you want to deploy on this server?" 18 72 3 \
      "full"    "Everything: web + backend + database (recommended)" "$full_state" \
      "backend" "Backend + database only (no web interface)" "$backend_state" \
      "web"     "Web interface only (backend is on another server)" "$web_state" >"$choice_file" \
      || { rm -f "$choice_file"; die "Installation cancelled"; }
    DEPLOY_MODE="$(cat "$choice_file")"
    rm -f "$choice_file"
    return
  fi

  echo ""
  echo "What do you want to deploy on this server?"
  echo "  1) full    - Everything: web interface + backend + database  [recommended]"
  echo "  2) backend - Backend + database only (no web interface)"
  echo "  3) web     - Web interface only (backend is on another server)"

  local default_choice="1"
  case "$DEPLOY_MODE" in
    full) default_choice="1" ;;
    backend) default_choice="2" ;;
    web) default_choice="3" ;;
  esac

  local choice
  read -r -p "Select mode [1-3] (default: $default_choice): " choice
  choice="$(trim_string "$choice")"
  choice="${choice:-$default_choice}"

  case "$choice" in
    1) DEPLOY_MODE="full" ;;
    2) DEPLOY_MODE="backend" ;;
    3) DEPLOY_MODE="web" ;;
    *) die "Invalid selection: $choice" ;;
  esac
}

choose_network_interactive() {
  if [[ "$UI_BACKEND" == "whiptail" ]]; then
    local tls_state="OFF"
    local http_state="OFF"
    case "$NETWORK_MODE" in
      tls) tls_state="ON" ;;
      http) http_state="ON" ;;
    esac

    NETWORK_MODE="$({
      whiptail --title "Seclettr Installer" --radiolist \
        "How should users connect to your server?\n(A certificate is generated automatically if needed)" 16 72 2 \
        "tls"  "HTTPS — encrypted, secure connections  [recommended]" "$tls_state" \
        "http" "HTTP only — no encryption (local/testing only)" "$http_state" \
        3>&1 1>&2 2>&3
    } )" || die "Installation cancelled"
    return
  fi

  if [[ "$UI_BACKEND" == "dialog" ]]; then
    local tls_state="off"
    local http_state="off"
    case "$NETWORK_MODE" in
      tls) tls_state="on" ;;
      http) http_state="on" ;;
    esac

    local choice_file
    choice_file="$(mktemp)"
    dialog --stdout --title "Seclettr Installer" --radiolist \
      "How should users connect to your server?" 16 72 2 \
      "tls"  "HTTPS — encrypted, secure connections (recommended)" "$tls_state" \
      "http" "HTTP only — no encryption (local/testing only)" "$http_state" >"$choice_file" \
      || { rm -f "$choice_file"; die "Installation cancelled"; }
    NETWORK_MODE="$(cat "$choice_file")"
    rm -f "$choice_file"
    return
  fi

  echo ""
  echo "How should users connect to your server?"
  echo "  1) HTTPS  - Encrypted connections, secure  [recommended]"
  echo "              (A certificate is generated automatically if needed)"
  echo "  2) HTTP   - No encryption (local/testing only)"

  local default_choice="1"
  if [[ "$NETWORK_MODE" == "http" ]]; then
    default_choice="2"
  fi

  local choice
  read -r -p "Select network mode [1-2] (default: $default_choice): " choice
  choice="$(trim_string "$choice")"
  choice="${choice:-$default_choice}"

  case "$choice" in
    1) NETWORK_MODE="tls" ;;
    2) NETWORK_MODE="http" ;;
    *) die "Invalid selection: $choice" ;;
  esac
}

prompt_web_runtime_urls_interactive() {
  if [[ "$UI_BACKEND" == "whiptail" ]]; then
    WEB_RUNTIME_API_URL="$({
      whiptail --title "Web Runtime Config" --inputbox \
        "API base URL (absolute URL or /api):" 11 88 "$WEB_RUNTIME_API_URL" \
        3>&1 1>&2 2>&3
    } )" || die "Installation cancelled"

    WEB_RUNTIME_SFU_URL="$({
      whiptail --title "Web Runtime Config" --inputbox \
        "SFU base URL (absolute URL or /sfu):" 11 88 "$WEB_RUNTIME_SFU_URL" \
        3>&1 1>&2 2>&3
    } )" || die "Installation cancelled"
    return
  fi

  if [[ "$UI_BACKEND" == "dialog" ]]; then
    local api_file
    local sfu_file
    api_file="$(mktemp)"
    sfu_file="$(mktemp)"

    dialog --stdout --title "Web Runtime Config" --inputbox \
      "API base URL (absolute URL or /api):" 11 88 "$WEB_RUNTIME_API_URL" >"$api_file" \
      || { rm -f "$api_file" "$sfu_file"; die "Installation cancelled"; }
    dialog --stdout --title "Web Runtime Config" --inputbox \
      "SFU base URL (absolute URL or /sfu):" 11 88 "$WEB_RUNTIME_SFU_URL" >"$sfu_file" \
      || { rm -f "$api_file" "$sfu_file"; die "Installation cancelled"; }

    WEB_RUNTIME_API_URL="$(cat "$api_file")"
    WEB_RUNTIME_SFU_URL="$(cat "$sfu_file")"
    rm -f "$api_file" "$sfu_file"
    return
  fi

  echo ""
  read -r -p "Web runtime API URL (default: $WEB_RUNTIME_API_URL): " WEB_RUNTIME_API_URL
  read -r -p "Web runtime SFU URL (default: $WEB_RUNTIME_SFU_URL): " WEB_RUNTIME_SFU_URL

  WEB_RUNTIME_API_URL="${WEB_RUNTIME_API_URL:-/api}"
  WEB_RUNTIME_SFU_URL="${WEB_RUNTIME_SFU_URL:-/sfu}"
}

prompt_domain_setup() {
  local domain=""

  if [[ "$UI_BACKEND" == "whiptail" ]]; then
    domain="$({
      whiptail --title "Seclettr Installer" --inputbox \
        "Server domain name (e.g. example.com)\nUsed for CORS_ORIGIN, TURN_DOMAIN, and the TLS certificate.\nLeave empty to use the detected IP address." 12 78 "" \
        3>&1 1>&2 2>&3
    } )" || true
    printf '%s' "$(trim_string "$domain")"
    return
  fi

  if [[ "$UI_BACKEND" == "dialog" ]]; then
    local tmp
    tmp="$(mktemp)"
    dialog --stdout --title "Seclettr Installer" --inputbox \
      "Server domain name (e.g. example.com)\nUsed for CORS_ORIGIN, TURN_DOMAIN, and the TLS certificate.\nLeave empty to use the detected IP address." 12 78 "" >"$tmp" || true
    domain="$(cat "$tmp")"
    rm -f "$tmp"
    printf '%s' "$(trim_string "$domain")"
    return
  fi

  echo ""
  echo "What domain name will people use to access this server?"
  echo "  Example: chat.example.com  or  example.com"
  echo "  Leave empty to use the server's public IP address instead."
  echo "  (This is used for the HTTPS certificate, CORS, and TURN settings.)"
  read -r -p "Domain [leave empty to use IP]: " domain
  printf '%s' "$(trim_string "$domain")"
}

prompt_update_source_interactive() {
  local previous_dir=""

  if [[ "$UI_BACKEND" == "whiptail" ]]; then
    previous_dir="$({
      whiptail --title "Seclettr Update" --inputbox \
        "Path to the previous Seclettr release directory.\nExample: /opt/seclettr/seclettr-release-main-20260429-120000\n\nThe installer will copy .env and TLS certificates from that directory." 13 88 "" \
        3>&1 1>&2 2>&3
    } )" || die "Update cancelled"
    printf '%s' "$(trim_string "$previous_dir")"
    return
  fi

  if [[ "$UI_BACKEND" == "dialog" ]]; then
    local tmp
    tmp="$(mktemp)"
    dialog --stdout --title "Seclettr Update" --inputbox \
      "Path to the previous Seclettr release directory.\nThe installer will copy .env and TLS certificates from that directory." 12 88 "" >"$tmp" \
      || { rm -f "$tmp"; die "Update cancelled"; }
    previous_dir="$(cat "$tmp")"
    rm -f "$tmp"
    printf '%s' "$(trim_string "$previous_dir")"
    return
  fi

  echo ""
  echo "Update mode needs the previous release directory."
  echo "The installer will copy .env and TLS certificates from it."
  echo "Example: /opt/seclettr/seclettr-release-main-20260429-120000"
  read -r -p "Previous release directory: " previous_dir
  printf '%s' "$(trim_string "$previous_dir")"
}

_quickstart_whiptail() {
  local detected_ip="${1:-}"
  local domain_hint=""
  [[ -n "$detected_ip" ]] && domain_hint="$detected_ip"

  local domain
  domain="$({
    whiptail --title "Seclettr — Quick Setup" --inputbox \
"Welcome to Seclettr!

Enter your server's domain name or leave empty to use the IP address.
  Example: chat.example.com

Everything else is configured automatically:
  • All services will be installed on this server
  • HTTPS will be enabled (certificate generated automatically)
  • All secret keys are generated automatically" \
      18 72 "$domain_hint" \
      3>&1 1>&2 2>&3
  })" || die "Installation cancelled"
  domain="$(trim_string "$domain")"

  DEPLOY_MODE="full"
  NETWORK_MODE="tls"
  CERT_MODE="selfsigned"

  if [[ -n "$domain" && ! $(is_ip_address "$domain") ]]; then
    local want_le
    want_le="$({
      whiptail --title "TLS Certificate" --yesno \
"Do you want a free trusted certificate from Let's Encrypt?

  YES — Trusted certificate, no browser warning
         (requires domain $domain to point to this server and port 80 to be free)

  NO  — Self-signed certificate  (browser will show a warning)" \
        14 72 \
        3>&1 1>&2 2>&3
      echo $?
    })" || want_le=1
    if [[ "$want_le" -eq 0 ]]; then
      CERT_MODE="letsencrypt"
      LETSENCRYPT_EMAIL="$({
        whiptail --title "TLS Certificate" --inputbox \
          "Email for Let's Encrypt expiry alerts (optional — press Enter to skip):" \
          10 72 "" \
          3>&1 1>&2 2>&3
      })" || true
      LETSENCRYPT_EMAIL="$(trim_string "$LETSENCRYPT_EMAIL")"
    fi
  fi

  printf '%s' "$domain"
}

_quickstart_text() {
  local detected_ip="${1:-}"

  echo ""
  echo -e "${CYN}${BLD}╔══════════════════════════════════════════════════╗${RST}"
  echo -e "${CYN}${BLD}║          Seclettr — Quick Setup                  ║${RST}"
  echo -e "${CYN}${BLD}╚══════════════════════════════════════════════════╝${RST}"
  echo ""
  echo "  All services will be installed on this server."
  echo "  HTTPS is enabled; secrets are generated automatically."
  echo ""
  if [[ -n "$detected_ip" ]]; then
    echo -e "  Detected public IP: ${GRN}${detected_ip}${RST}"
  fi
  echo ""

  local prompt_hint=""
  [[ -n "$detected_ip" ]] && prompt_hint=" (or press Enter to use IP $detected_ip)"

  local domain
  read -r -p "  Domain name for your server${prompt_hint}: " domain
  domain="$(trim_string "$domain")"

  DEPLOY_MODE="full"
  NETWORK_MODE="tls"
  CERT_MODE="selfsigned"

  if [[ -n "$domain" ]] && ! is_ip_address "$domain"; then
    echo ""
    echo "  TLS certificate options for ${domain}:"
    echo "    1) Let's Encrypt — trusted, no browser warning  [recommended]"
    echo "       (port 80 must be open and DNS must point to this server)"
    echo "    2) Self-signed   — browser will show a security warning"
    local cert_choice
    read -r -p "  Certificate type [1-2] (default: 1): " cert_choice
    cert_choice="$(trim_string "$cert_choice")"
    cert_choice="${cert_choice:-1}"
    if [[ "$cert_choice" == "1" ]]; then
      CERT_MODE="letsencrypt"
      read -r -p "  Let's Encrypt email (optional, press Enter to skip): " LETSENCRYPT_EMAIL
      LETSENCRYPT_EMAIL="$(trim_string "$LETSENCRYPT_EMAIL")"
    fi
  fi

  printf '%s' "$domain"
}

configure_interactive_inputs() {
  if ! is_interactive_enabled; then
    return
  fi

  detect_ui_backend

  # Quick-start path: fresh install with no CLI overrides for mode/network.
  # Only offer the advanced multi-screen flow if the user explicitly passed
  # --mode, --network, or --interactive with mode!=full (they know what they want).
  local use_quickstart=true
  if [[ -n "$CLI_DEPLOY_MODE" || -n "$CLI_NETWORK_MODE" ]]; then
    use_quickstart=false
  fi
  # Advanced mode/network already set to non-defaults → skip quickstart
  if [[ "$DEPLOY_MODE" != "full" && -n "$DEPLOY_MODE" ]]; then
    use_quickstart=false
  fi

  if [[ "$use_quickstart" == "true" ]]; then
    # Detect IP first so we can pre-fill the domain hint
    local detected_ip_qs=""
    if command -v curl >/dev/null 2>&1; then
      detected_ip_qs="$(detect_public_ip)" || detected_ip_qs=""
    fi

    local qs_domain=""
    if [[ "$UI_BACKEND" == "whiptail" || "$UI_BACKEND" == "dialog" ]]; then
      qs_domain="$(_quickstart_whiptail "$detected_ip_qs")"
    else
      qs_domain="$(_quickstart_text "$detected_ip_qs")"
    fi

    # Apply domain to env immediately (fill_env_secrets runs later but uses SETUP_DOMAIN)
    SETUP_DOMAIN="$qs_domain"
    # Defaults are already set inside _quickstart_*
    return
  fi

  # Advanced / non-default path: show individual prompts as before
  if [[ "${_WELCOME_SHOWN:-false}" != "true" ]]; then
    show_welcome_banner
    _WELCOME_SHOWN=true
  fi
  choose_mode_interactive
  choose_network_interactive

  if [[ "$NETWORK_MODE" == "tls" ]]; then
    choose_cert_mode_interactive
  fi

  if [[ "$DEPLOY_MODE" == "web" ]]; then
    prompt_web_runtime_urls_interactive
  fi
}

prepare_update_from_previous() {
  if [[ "$ACTION" != "update" ]]; then
    return
  fi

  if [[ -z "$CLI_UPDATE_FROM" && -f "$ENV_FILE" ]]; then
    log_ok "Update mode: using existing $ENV_FILE from this directory"
    return
  fi

  if [[ -z "$CLI_UPDATE_FROM" ]]; then
    if ! is_interactive_enabled; then
      die "Update mode needs --from <previous-release-directory> when $ENV_FILE is not present"
    fi
    detect_ui_backend
    if [[ "${_WELCOME_SHOWN:-false}" != "true" ]]; then
      show_welcome_banner
      _WELCOME_SHOWN=true
    fi
    CLI_UPDATE_FROM="$(prompt_update_source_interactive)"
  fi

  [[ -n "$CLI_UPDATE_FROM" ]] || die "Previous release directory is required for update mode"
  [[ -d "$CLI_UPDATE_FROM" ]] || die "Previous release directory not found: $CLI_UPDATE_FROM"

  PREVIOUS_BUNDLE_DIR="$(cd "$CLI_UPDATE_FROM" && pwd)"
  [[ "$PREVIOUS_BUNDLE_DIR" != "$BUNDLE_DIR" ]] || die "Previous release directory points to the current bundle"
  [[ -f "$PREVIOUS_BUNDLE_DIR/.env" ]] || die "Previous release has no .env: $PREVIOUS_BUNDLE_DIR/.env"

  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$PREVIOUS_BUNDLE_DIR/.env" "$ENV_FILE"
    log_ok "Copied runtime settings from previous release: $PREVIOUS_BUNDLE_DIR/.env"
  else
    log_warn "$ENV_FILE already exists — keeping it instead of copying previous .env"
  fi

  if [[ -d "$PREVIOUS_BUNDLE_DIR/nginx/certs" ]]; then
    mkdir -p "$BUNDLE_DIR/nginx/certs"
    cp -a "$PREVIOUS_BUNDLE_DIR/nginx/certs/." "$BUNDLE_DIR/nginx/certs/" 2>/dev/null || true
    log_ok "Copied TLS certificates from previous release"
  fi

  if [[ -f "$PREVIOUS_BUNDLE_DIR/nginx/runtime-config.js" && ! -f "$RUNTIME_CONFIG_FILE" ]]; then
    mkdir -p "$(dirname "$RUNTIME_CONFIG_FILE")"
    cp "$PREVIOUS_BUNDLE_DIR/nginx/runtime-config.js" "$RUNTIME_CONFIG_FILE"
  fi
}

env_has_placeholders() {
  grep -q "CHANGE_ME" "$ENV_FILE" 2>/dev/null
}

handoff_update_target() {
  local update_target_abs
  update_target_abs="$(absolute_path "$CLI_UPDATE_ARCHIVE")"

  local parent_dir
  parent_dir="$(cd "$BUNDLE_DIR/.." && pwd)"

  local new_bundle_dir=""

  if [[ -d "$update_target_abs" ]]; then
    new_bundle_dir="$(cd "$update_target_abs" && pwd)"
    [[ -f "$new_bundle_dir/install.sh" ]] \
      || die "Update directory is not a Seclettr release bundle: $new_bundle_dir"
    log_ok "Using unpacked update bundle: $new_bundle_dir"
  else
    [[ -f "$update_target_abs" ]] || die "Update archive or directory not found: $CLI_UPDATE_ARCHIVE"
    require_command tar

    local top_level=""
    if ! top_level="$(tar -tzf "$update_target_abs" 2>/dev/null | awk -F/ 'NF && $1 != "." { print $1; exit }')"; then
      local file_kind="unknown"
      if command -v file >/dev/null 2>&1; then
        file_kind="$(file -b "$update_target_abs" 2>/dev/null || printf 'unknown')"
      fi
      die "Could not inspect update archive: $update_target_abs
  File type: $file_kind
  Expected: gzip-compressed tar archive created by scripts/release-build.sh
  Check it with: tar -tzf '$update_target_abs' | head
  Or pass an unpacked bundle directory instead: ./install.sh update /opt/seclettr-release-NEW"
    fi

    [[ -n "$top_level" ]] || die "Archive has no top-level directory: $update_target_abs"
    [[ "$top_level" != *".."* && "$top_level" != /* ]] || die "Unsafe top-level directory in archive: $top_level"

    new_bundle_dir="$parent_dir/$top_level"
    if [[ -e "$new_bundle_dir" ]]; then
      [[ -d "$new_bundle_dir" && -f "$new_bundle_dir/install.sh" ]] \
        || die "Target update directory already exists but is not a Seclettr bundle: $new_bundle_dir"
      log_warn "Update bundle already unpacked — using $new_bundle_dir"
    else
      log_step "Unpacking update archive"
      tar -xzf "$update_target_abs" -C "$parent_dir"
      log_ok "Unpacked update bundle to $new_bundle_dir"
    fi
  fi

  [[ "$new_bundle_dir" != "$BUNDLE_DIR" ]] || die "Update target points to the current bundle"
  [[ -f "$new_bundle_dir/install.sh" ]] || die "New bundle has no install.sh: $new_bundle_dir"
  chmod +x "$new_bundle_dir/install.sh" 2>/dev/null || true

  local handoff_args=(update --from "$BUNDLE_DIR")
  [[ "$INTERACTIVE_MODE" == "true" ]] && handoff_args+=(--interactive)
  [[ "$INTERACTIVE_MODE" == "false" ]] && handoff_args+=(--non-interactive)
  [[ -n "$CLI_DEPLOY_MODE" ]] && handoff_args+=(--mode "$CLI_DEPLOY_MODE")
  [[ -n "$CLI_NETWORK_MODE" ]] && handoff_args+=(--network "$CLI_NETWORK_MODE")
  [[ -n "$CLI_WEB_RUNTIME_API_URL" ]] && handoff_args+=(--web-api-url "$CLI_WEB_RUNTIME_API_URL")
  [[ -n "$CLI_WEB_RUNTIME_SFU_URL" ]] && handoff_args+=(--web-sfu-url "$CLI_WEB_RUNTIME_SFU_URL")
  [[ -n "$CLI_CERT_MODE" ]] && handoff_args+=(--cert-mode "$CLI_CERT_MODE")
  [[ -n "$CLI_LETSENCRYPT_EMAIL" ]] && handoff_args+=(--letsencrypt-email "$CLI_LETSENCRYPT_EMAIL")
  [[ "$PROJECT_NAME" != "seclettr" ]] && handoff_args+=(--project-name "$PROJECT_NAME")
  [[ "$SKIP_LOAD" == "true" ]] && handoff_args+=(--skip-load)
  [[ "$SKIP_MIGRATE" == "true" ]] && handoff_args+=(--skip-migrate)
  [[ "$SKIP_BACKUP" == "true" ]] && handoff_args+=(--skip-backup)

  echo ""
  echo -e "${CYN}${BLD}Handing off update to:${RST} $new_bundle_dir/install.sh"
  echo -e "${DIM}Previous release: $BUNDLE_DIR${RST}"
  echo -e "${DIM}Command: ./install.sh ${handoff_args[*]}${RST}"
  echo ""

  cd "$new_bundle_dir"
  exec bash ./install.sh "${handoff_args[@]}"
}

set_selected_services() {
  case "$DEPLOY_MODE" in
    full)
      SELECTED_SERVICES=(postgres redis minio minio-init coturn api sfu web)
      ;;
    backend)
      SELECTED_SERVICES=(postgres redis minio minio-init coturn api sfu)
      ;;
    web)
      SELECTED_SERVICES=(web)
      ;;
    *)
      die "Unsupported deployment mode: $DEPLOY_MODE"
      ;;
  esac
}

compute_excluded_services() {
  EXCLUDED_SERVICES=()
  local service
  for service in "${ALL_SERVICES[@]}"; do
    local selected=false
    local current
    for current in "${SELECTED_SERVICES[@]}"; do
      if [[ "$current" == "$service" ]]; then
        selected=true
        break
      fi
    done

    if [[ "$selected" == "false" ]]; then
      EXCLUDED_SERVICES+=("$service")
    fi
  done
}

reconcile_service_mode() {
  compute_excluded_services
  if [[ ${#EXCLUDED_SERVICES[@]} -eq 0 ]]; then
    return
  fi

  log_step "Stopping services not used by mode '$DEPLOY_MODE'"
  docker_compose rm -sf "${EXCLUDED_SERVICES[@]}" >/dev/null 2>&1 || true
}

validate_required_secret() {
  local name="$1"
  local value="$2"

  if [[ -z "$value" || "$value" == *CHANGE_ME* ]]; then
    die "Set a real value for $name in $ENV_FILE before running install.sh"
  fi
}

validate_backend_config() {
  validate_required_secret POSTGRES_PASSWORD "${POSTGRES_PASSWORD:-}"
  validate_required_secret REDIS_PASSWORD "${REDIS_PASSWORD:-}"
  validate_required_secret JWT_SECRET "${JWT_SECRET:-}"
  validate_required_secret TURN_SECRET "${TURN_SECRET:-}"
  validate_required_secret MINIO_ACCESS_KEY "${MINIO_ACCESS_KEY:-}"
  validate_required_secret MINIO_SECRET_KEY "${MINIO_SECRET_KEY:-}"
  validate_required_secret METRICS_BEARER_TOKEN "${METRICS_BEARER_TOKEN:-}"
  validate_required_secret CORS_ORIGIN "${CORS_ORIGIN:-}"
  validate_required_secret TURN_DOMAIN "${TURN_DOMAIN:-}"
  validate_required_secret TURN_EXTERNAL_IP "${TURN_EXTERNAL_IP:-}"
  validate_required_secret ANNOUNCED_IP "${ANNOUNCED_IP:-}"

  if [[ ${#JWT_SECRET} -lt 32 ]]; then
    die "JWT_SECRET must be at least 32 characters"
  fi

  if [[ ${#METRICS_BEARER_TOKEN} -lt 16 ]]; then
    die "METRICS_BEARER_TOKEN must be at least 16 characters"
  fi

  if [[ "${TURN_EXTERNAL_IP:-}" == "127.0.0.1" || "${ANNOUNCED_IP:-}" == "127.0.0.1" ]]; then
    log_warn "TURN_EXTERNAL_IP or ANNOUNCED_IP still points to 127.0.0.1. Calls will not work from other devices."
  fi
}

configure_network_mode() {
  case "$NETWORK_MODE" in
    tls)
      NGINX_CONFIG="nginx.conf"
      ;;
    http)
      NGINX_CONFIG="nginx.http.conf"
      ;;
    *)
      die "Unsupported network mode: $NETWORK_MODE"
      ;;
  esac

  export NGINX_CONFIG

  if ! is_mode_with_web; then
    return
  fi

  if [[ "$NETWORK_MODE" == "http" && "$DEPLOY_MODE" == "full" && "${COOKIE_SECURE:-true}" != "false" ]]; then
    log_warn "HTTP full-stack mode selected — setting COOKIE_SECURE=false so login works without HTTPS."
    set_env_value COOKIE_SECURE false
  fi

  if [[ "$NETWORK_MODE" == "http" ]] && is_mode_with_backend && [[ "${CORS_ORIGIN:-}" == https://* && "${CORS_ORIGIN:-}" != *,* ]]; then
    local http_origin="http://${CORS_ORIGIN#https://}"
    log_warn "HTTP mode selected — changing CORS_ORIGIN to ${http_origin}."
    set_env_value CORS_ORIGIN "$http_origin"
  fi

  if [[ "$NETWORK_MODE" == "http" && "$DEPLOY_MODE" == "web" ]]; then
    log_warn "Web-only HTTP mode selected. Ensure your external backend cookie policy matches plain HTTP usage."
  fi

  if [[ "$NETWORK_MODE" == "tls" ]]; then
    local cert_path="$BUNDLE_DIR/nginx/certs/cert.pem"
    local key_path="$BUNDLE_DIR/nginx/certs/key.pem"

    if [[ -f "$cert_path" && -f "$key_path" ]]; then
      # Certificate already exists — ensure nginx (root) can read it.
      log_ok "TLS certificate found — using existing nginx/certs/{cert,key}.pem"
      chmod 644 "$cert_path" "$key_path" 2>/dev/null || true
    else
      local cert_domain="${TURN_DOMAIN:-localhost}"
      local cert_ip="${ANNOUNCED_IP:-}"
      local effective_cert_mode="${CERT_MODE:-selfsigned}"

      if [[ "$effective_cert_mode" == "letsencrypt" ]]; then
        if provision_letsencrypt_cert "$cert_domain" "$LETSENCRYPT_EMAIL" "$BUNDLE_DIR/nginx/certs"; then
          chmod 644 "$cert_path" "$key_path" 2>/dev/null || true
          setup_letsencrypt_renewal "$cert_domain" "$BUNDLE_DIR/nginx/certs"
        else
          log_warn "Let's Encrypt failed — falling back to self-signed certificate"
          effective_cert_mode="selfsigned"
        fi
      fi

      if [[ "$effective_cert_mode" == "selfsigned" ]]; then
        log_step "No TLS certificate found — generating self-signed cert for ${cert_domain}"
        gen_self_signed_cert "$BUNDLE_DIR/nginx/certs" "$cert_domain" "$cert_ip"
        # gen_self_signed_cert already sets 644 on key.pem
        log_ok "Self-signed certificate written to nginx/certs/"
        log_warn "Self-signed certificate is in use. Browsers will show a security warning."
        log_warn "Replace nginx/certs/cert.pem and key.pem with a trusted certificate for production."
      fi
    fi
  fi
}

escape_js_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

write_runtime_config() {
  local api_url_escaped
  local sfu_url_escaped

  mkdir -p "$(dirname "$RUNTIME_CONFIG_FILE")"

  api_url_escaped="$(escape_js_string "$WEB_RUNTIME_API_URL")"
  sfu_url_escaped="$(escape_js_string "$WEB_RUNTIME_SFU_URL")"

  cat >"$RUNTIME_CONFIG_FILE" <<EOF_CONFIG
window.__SECLETTR_RUNTIME_CONFIG__ = Object.freeze({
  apiUrl: "${api_url_escaped}",
  sfuUrl: "${sfu_url_escaped}",
});
EOF_CONFIG
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    install)
      ACTION="install"
      shift
      ;;
    update|upgrade)
      ACTION="update"
      if [[ $# -ge 2 && "${2:-}" != -* ]]; then
        CLI_UPDATE_ARCHIVE="$2"
        shift 2
      else
        shift
      fi
      ;;
    --update)
      ACTION="update"
      if [[ $# -ge 2 && "${2:-}" != -* ]]; then
        CLI_UPDATE_ARCHIVE="$2"
        shift 2
      else
        shift
      fi
      ;;
    --from)
      CLI_UPDATE_FROM="$2"
      shift 2
      ;;
    --mode)
      CLI_DEPLOY_MODE="$2"
      shift 2
      ;;
    --network)
      CLI_NETWORK_MODE="$2"
      shift 2
      ;;
    --web-api-url)
      CLI_WEB_RUNTIME_API_URL="$2"
      shift 2
      ;;
    --web-sfu-url)
      CLI_WEB_RUNTIME_SFU_URL="$2"
      shift 2
      ;;
    --interactive)
      INTERACTIVE_MODE="true"
      shift
      ;;
    --non-interactive)
      INTERACTIVE_MODE="false"
      shift
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --compose-file)
      COMPOSE_FILE="$2"
      shift 2
      ;;
    --image-archive)
      IMAGE_ARCHIVE="$2"
      shift 2
      ;;
    --project-name)
      PROJECT_NAME="$2"
      shift 2
      ;;
    --cert-mode)
      CLI_CERT_MODE="$2"
      shift 2
      ;;
    --letsencrypt-email)
      CLI_LETSENCRYPT_EMAIL="$2"
      shift 2
      ;;
    --skip-load)
      SKIP_LOAD=true
      shift
      ;;
    --skip-migrate)
      SKIP_MIGRATE=true
      shift
      ;;
    --skip-backup)
      SKIP_BACKUP=true
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

case "$ACTION" in
  install|update) ;;
  *) die "Invalid action '$ACTION'. Use install or update" ;;
esac

if [[ "$ACTION" == "update" && -z "$CLI_UPDATE_ARCHIVE" && -z "$CLI_UPDATE_FROM" && ! -f "$ENV_FILE" ]]; then
  # update with no args and no existing .env → auto-fetch latest release and hand off
  CLI_UPDATE_ARCHIVE="$(fetch_latest_release_archive)"
fi

if [[ -n "$CLI_UPDATE_ARCHIVE" ]]; then
  handoff_update_target
fi

ensure_system_deps
require_command grep
require_command awk
require_command openssl
resolve_docker_cmd

[[ -f "$COMPOSE_FILE" ]] || die "Compose file not found: $COMPOSE_FILE"

prepare_update_from_previous

GENERATED_ENV=false
if [[ ! -f "$ENV_FILE" ]]; then
  [[ -f "$ENV_TEMPLATE" ]] || die "Environment template not found: $ENV_TEMPLATE"
  cp "$ENV_TEMPLATE" "$ENV_FILE"
  GENERATED_ENV=true
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

ENV_NEEDS_GENERATION=false
if env_has_placeholders; then
  ENV_NEEDS_GENERATION=true
fi

# Run the interactive setup early (before secrets generation) so the user's
# domain and mode choices are available to fill_env_secrets.
# Update mode must reuse the previous release configuration. Do not launch the
# fresh-install quickstart there, otherwise an upgrade can silently rewrite
# deployment mode/cert choices or look like it only prepared .env.
if [[ "$ACTION" != "update" && ( "$GENERATED_ENV" == "true" || "$ENV_NEEDS_GENERATION" == "true" ) ]] && is_interactive_enabled; then
  configure_interactive_inputs
  _CONFIGURE_DONE=true
fi

if [[ "$GENERATED_ENV" == "true" || "$ENV_NEEDS_GENERATION" == "true" ]]; then
  if [[ "$GENERATED_ENV" == "true" ]]; then
    log_step "No .env found — auto-generating settings and secrets"
  else
    log_step "Found placeholder values in .env — auto-generating missing secrets"
  fi

  DETECTED_IP=""
  if command -v curl >/dev/null 2>&1; then
    log_step "Detecting public IP address..."
    DETECTED_IP="$(detect_public_ip)" || DETECTED_IP=""
    if [[ -n "$DETECTED_IP" ]]; then
      log_ok "Detected public IP: $DETECTED_IP"
    else
      log_warn "Could not detect public IP — set TURN_EXTERNAL_IP and ANNOUNCED_IP in $ENV_FILE manually"
    fi
  fi

  # SETUP_DOMAIN may already be set by configure_interactive_inputs (quickstart path).
  if [[ -z "${SETUP_DOMAIN:-}" ]] && is_interactive_enabled; then
    detect_ui_backend
    SETUP_DOMAIN="$(prompt_domain_setup)"
  fi
  SETUP_DOMAIN="${SETUP_DOMAIN:-}"

  fill_env_secrets "$ENV_FILE" "$DETECTED_IP" "$SETUP_DOMAIN"

  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a

  log_ok "Secrets written to $ENV_FILE"
  if [[ "$ACTION" == "update" ]]; then
    log_ok "Continuing update after filling missing .env values"
  else
    log_warn "Review $ENV_FILE before production use, especially CORS_ORIGIN, TURN_DOMAIN, and COOKIE_SECURE"
  fi
fi

apply_bundle_image_refs

DEPLOY_MODE="${CLI_DEPLOY_MODE:-${DEPLOY_MODE:-full}}"
if [[ -n "${CLI_NETWORK_MODE:-}" ]]; then
  NETWORK_MODE="$CLI_NETWORK_MODE"
elif [[ -n "${NETWORK_MODE:-}" ]]; then
  NETWORK_MODE="$NETWORK_MODE"
elif [[ "${NGINX_CONFIG:-nginx.conf}" == "nginx.http.conf" ]]; then
  NETWORK_MODE="http"
else
  NETWORK_MODE="tls"
fi

WEB_RUNTIME_API_URL="${CLI_WEB_RUNTIME_API_URL:-${WEB_RUNTIME_API_URL:-/api}}"
WEB_RUNTIME_SFU_URL="${CLI_WEB_RUNTIME_SFU_URL:-${WEB_RUNTIME_SFU_URL:-/sfu}}"
CERT_MODE="${CLI_CERT_MODE:-${CERT_MODE:-}}"
LETSENCRYPT_EMAIL="${CLI_LETSENCRYPT_EMAIL:-${LETSENCRYPT_EMAIL:-}}"

if [[ -n "$CERT_MODE" && "$CERT_MODE" != "selfsigned" && "$CERT_MODE" != "letsencrypt" ]]; then
  die "Invalid --cert-mode '$CERT_MODE'. Use: selfsigned or letsencrypt"
fi

DEPLOY_MODE="$(trim_string "$DEPLOY_MODE")"
NETWORK_MODE="$(trim_string "$NETWORK_MODE")"
WEB_RUNTIME_API_URL="$(normalize_runtime_url "$WEB_RUNTIME_API_URL")"
WEB_RUNTIME_SFU_URL="$(normalize_runtime_url "$WEB_RUNTIME_SFU_URL")"

validate_mode "$DEPLOY_MODE"
validate_network_mode "$NETWORK_MODE"

# Skip if already called early (quickstart path during secret generation).
# Update mode reuses the previous .env and must not show first-install prompts.
if [[ "$ACTION" != "update" && "${_CONFIGURE_DONE:-false}" != "true" ]]; then
  configure_interactive_inputs
fi

DEPLOY_MODE="$(trim_string "$DEPLOY_MODE")"
NETWORK_MODE="$(trim_string "$NETWORK_MODE")"
WEB_RUNTIME_API_URL="$(normalize_runtime_url "${WEB_RUNTIME_API_URL:-/api}")"
WEB_RUNTIME_SFU_URL="$(normalize_runtime_url "${WEB_RUNTIME_SFU_URL:-/sfu}")"

validate_mode "$DEPLOY_MODE"
validate_network_mode "$NETWORK_MODE"

if ! is_valid_runtime_url "$WEB_RUNTIME_API_URL"; then
  die "Invalid web runtime API URL '$WEB_RUNTIME_API_URL'. Use absolute http(s) URL or a path like /api"
fi

if ! is_valid_runtime_url "$WEB_RUNTIME_SFU_URL"; then
  die "Invalid web runtime SFU URL '$WEB_RUNTIME_SFU_URL'. Use absolute http(s) URL or a path like /sfu"
fi

if [[ "$DEPLOY_MODE" == "web" && "$WEB_RUNTIME_API_URL" == "/api" ]]; then
  log_warn "Web-only mode uses default /api runtime URL. This only works if /api is routed to an external backend."
fi

if [[ "$DEPLOY_MODE" == "web" && "$WEB_RUNTIME_SFU_URL" == "/sfu" ]]; then
  log_warn "Web-only mode uses default /sfu runtime URL. This only works if /sfu is routed to an external backend."
fi

# ── Installation steps ─────────────────────────────────────────────────────────

# Adjust total step count for skipped optional phases before any output.
[[ "$SKIP_LOAD" == "true" ]]    && _TOTAL_STEPS=$(( _TOTAL_STEPS - 1 ))
[[ "$SKIP_MIGRATE" == "true" ]] && _TOTAL_STEPS=$(( _TOTAL_STEPS - 1 ))
[[ "$ACTION" == "update" && "$SKIP_BACKUP" == "false" ]] && _TOTAL_STEPS=$(( _TOTAL_STEPS + 1 ))

step "Preparing configuration"
configure_network_mode
sync_s3_public_url
set_selected_services

if is_mode_with_backend; then
  validate_backend_config
fi

if [[ "$DEPLOY_MODE" == "web" && "$SKIP_MIGRATE" == "false" ]]; then
  log_warn "Skipping migrations in web-only mode."
  SKIP_MIGRATE=true
fi

write_runtime_config
echo -e "       ${GRN}✓${RST} Runtime config written"

step "Validating Compose file"
run_quiet "Checking docker-compose.yml" docker_compose config

if [[ "$ACTION" == "update" && "$SKIP_BACKUP" == "false" ]]; then
  step "Creating update backup"
  create_update_backup
fi

if [[ "$SKIP_LOAD" == "false" ]]; then
  if [[ -f "$IMAGE_ARCHIVE" ]]; then
    step "Loading Docker images from offline archive"
    run_quiet "Importing prebuilt-images.tar.gz (this may take a minute…)" \
      "${DOCKER_CMD[@]}" load -i "$IMAGE_ARCHIVE"
  else
    step "Pulling Docker images from registry"
    run_quiet "Pulling images from container registry" \
      docker_compose pull
  fi
fi

validate_runtime_images_available

if [[ "$SKIP_MIGRATE" == "false" ]]; then
  step "Running database migrations"
  run_quiet "Applying pending migrations" \
    docker_compose --profile ops run --rm migrate
fi

step "Stopping unused services"
reconcile_service_mode

step "Starting Seclettr"
echo "       Services: ${SELECTED_SERVICES[*]}"
run_quiet "Launching containers" \
  docker_compose up -d "${SELECTED_SERVICES[@]}"

step "Verifying container health"
# Give containers a moment to initialise before showing status
sleep 3
docker_compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null \
  || docker_compose ps

if is_mode_with_web; then
  step "Verifying web reachability"
  run_quiet "Probing deployed web runtime" verify_web_reachability
fi

# ── Final summary ──────────────────────────────────────────────────────────────

_WEB_PROTO="https"
[[ "$NETWORK_MODE" == "http" ]] && _WEB_PROTO="http"
_WEB_HOST="${TURN_DOMAIN:-$(hostname -f 2>/dev/null || hostname)}"

_cert_type="trusted"
_cert_warning=""
if [[ "$NETWORK_MODE" == "tls" ]]; then
  if command -v openssl >/dev/null 2>&1 && [[ -f "$BUNDLE_DIR/nginx/certs/cert.pem" ]]; then
    _cert_issuer="$(openssl x509 -noout -issuer  -in "$BUNDLE_DIR/nginx/certs/cert.pem" 2>/dev/null)"
    _cert_subject="$(openssl x509 -noout -subject -in "$BUNDLE_DIR/nginx/certs/cert.pem" 2>/dev/null)"
    [[ "$_cert_issuer" == "$_cert_subject" ]] && _cert_type="self-signed"
  fi
fi

if [[ "$_cert_type" == "self-signed" ]]; then
  _cert_display="${YLW}⚠️ Self-signed certificate${RST}"
  _cert_warning="Browser will show a security warning — this is normal for testing. Use Let's Encrypt or a trusted certificate for production."
else
  _cert_display="${GRN}✅ Trusted certificate${RST}"
fi

echo ""
echo -e "${GRN}${BLD}╔════════════════════════════════════════════════════════════╗${RST}"
echo -e "${GRN}${BLD}║                                                            ║${RST}"
echo -e "${GRN}${BLD}║   🚀  Seclettr is up and running!                        ║${RST}"
echo -e "${GRN}${BLD}║                                                            ║${RST}"
echo -e "${GRN}${BLD}╚════════════════════════════════════════════════════════════╝${RST}"
echo ""

echo -e "${BLD}═══════════════════════════════════════════════════════════════════════${RST}"
echo -e "${BLD}  OPEN IN BROWSER:${RST}"
echo -e ""
echo -e "     ${GRN}${BLD}${_WEB_PROTO}://${_WEB_HOST}${RST}"
echo -e ""
echo -e "${BLD}═══════════════════════════════════════════════════════════════════════${RST}"
echo ""

echo -e "${BLD}📋 Next steps:${RST}"
echo ""
echo -e "  1️⃣  Open the link above in your browser"
echo -e "  2️⃣  Click \"Register\" and create your first account"
echo -e "  3️⃣  Share the link with other users"
echo ""

if [[ -n "$_cert_warning" ]]; then
  echo -e "${BLD}🔒 Security certificate:${RST} $_cert_display"
  echo -e "     $_cert_warning"
  echo ""
fi

if is_mode_with_backend; then
  echo -e "${DIM}─────────────────────────────────────────────────────────────────────────${RST}"
  echo -e "${BLD}⚙️  For technical users:${RST}"
  echo ""
  echo -e "  API health:       http://127.0.0.1:${API_HOST_PORT:-3001}/health"
  echo -e "  Settings file:    ${ENV_FILE}"
  echo -e "  ${DIM}(keep this file safe — it contains all your secrets)${RST}"
  echo ""
  _DC_PREFIX="docker compose -p ${PROJECT_NAME} --env-file \"${ENV_FILE}\" -f \"${COMPOSE_FILE}\""
  echo -e "  Commands:"
  echo -e "    View logs:    ${_DC_PREFIX} logs -f"
  echo -e "    Stop:         ${_DC_PREFIX} down"
  echo -e "    Restart:      ${_DC_PREFIX} restart"
  echo -e "    Update:       unpack a new release and run:"
  echo -e "                  ./install.sh update --from \"${BUNDLE_DIR}\""
fi

if [[ "$ACTION" == "update" && -n "$BACKUP_DIR" ]]; then
  echo -e ""
  echo -e "  📦 Backup before update: ${BACKUP_DIR}"
fi

echo ""
echo -e "${GRN}${BLD}═══════════════════════════════════════════════════════════════════════${RST}"
echo -e "${GRN}${BLD}  Done! You can now use Seclettr.${RST}"
echo -e "${GRN}${BLD}═══════════════════════════════════════════════════════════════════════${RST}"
echo ""
