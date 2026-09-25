#!/usr/bin/env bash
# Seclettr one-line installer bootstrap.
# Downloads the latest release from GitHub, verifies integrity, and runs install.sh.
#
# Usage (run as root or with sudo):
#   curl -fsSL https://raw.githubusercontent.com/stepan-pavlenko/seclettr/main/scripts/ops/install-bootstrap.sh | sudo bash
#
# Non-interactive (all defaults):
#   curl -fsSL .../install-bootstrap.sh | sudo bash -s -- --non-interactive
#
# Or download the script first and run it:
#   curl -fLO https://raw.githubusercontent.com/stepan-pavlenko/seclettr/main/scripts/ops/install-bootstrap.sh
#   chmod +x install-bootstrap.sh
#   sudo ./install-bootstrap.sh
set -euo pipefail

GITHUB_REPO="stepan-pavlenko/seclettr"
GITHUB_API="https://api.github.com"
INSTALL_DIR="${SECLETTR_INSTALL_DIR:-/opt/seclettr}"

RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[0;33m'
CYN='\033[0;36m'
BLD='\033[1m'
DIM='\033[2m'
RST='\033[0m'

die()  { echo -e "${RED}ERR${RST} $*" >&2; exit 1; }
log()  { echo -e "${CYN}==>${RST} $*"; }
ok()   { echo -e "${GRN}OK${RST}  $*"; }
warn() { echo -e "${YLW}WARN${RST} $*"; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1 — install it and retry."
}

# ── Argument pass-through ──────────────────────────────────────────────────────

PASS_ARGS=()
INSTALL_DIR_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir)
      INSTALL_DIR_OVERRIDE="$2"
      shift 2
      ;;
    *)
      PASS_ARGS+=("$1")
      shift
      ;;
  esac
done

[[ -n "$INSTALL_DIR_OVERRIDE" ]] && INSTALL_DIR="$INSTALL_DIR_OVERRIDE"

# ── Sanity checks ──────────────────────────────────────────────────────────────

require_cmd curl
require_cmd tar

if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  die "Neither sha256sum nor shasum is available. Install coreutils and retry."
fi

# ── Banner ─────────────────────────────────────────────────────────────────────

echo ""
echo -e "${CYN}${BLD}╔══════════════════════════════════════════════════╗${RST}"
echo -e "${CYN}${BLD}║          Seclettr — One-Line Installer           ║${RST}"
echo -e "${CYN}${BLD}╚══════════════════════════════════════════════════╝${RST}"
echo ""
echo -e "  ${DIM}Repository:${RST} ${GITHUB_REPO}"
echo -e "  ${DIM}Install to:${RST} ${INSTALL_DIR}"
echo ""

# ── Fetch the latest release info ─────────────────────────────────────────────

log "Fetching latest release info from GitHub..."

RELEASE_JSON="$(
  curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    "${GITHUB_API}/repos/${GITHUB_REPO}/releases" \
  | grep -o '"tag_name":"[^"]*"\|"name":"[^"]*"\|"browser_download_url":"[^"]*"' \
  | head -80
)"

# Find first release that has a .tar.gz bundle
ASSET_URL=""
CHECKSUM_URL=""

while IFS= read -r line; do
  if [[ "$line" == *browser_download_url* ]]; then
    url="${line#*:\"}"
    url="${url%\"}"
    if [[ "$url" == *seclettr-release-*.tar.gz && "$url" != *.sha256 ]]; then
      [[ -z "$ASSET_URL" ]] && ASSET_URL="$url"
    fi
    if [[ "$url" == *seclettr-release-*.tar.gz.sha256 ]]; then
      [[ -z "$CHECKSUM_URL" ]] && CHECKSUM_URL="$url"
    fi
  fi
done <<< "$RELEASE_JSON"

if [[ -z "$ASSET_URL" ]]; then
  die "No release bundle found at ${GITHUB_API}/repos/${GITHUB_REPO}/releases. Check that releases exist."
fi

ARCHIVE_NAME="$(basename "$ASSET_URL")"
BUNDLE_SLUG="${ARCHIVE_NAME%.tar.gz}"

ok "Found: ${ARCHIVE_NAME}"
echo ""

# ── Create install directory ───────────────────────────────────────────────────

mkdir -p "$INSTALL_DIR"
WORK_DIR="$(mktemp -d "$INSTALL_DIR/.bootstrap-XXXXXX")"
# shellcheck disable=SC2064
trap "rm -rf '$WORK_DIR'" EXIT

# ── Download bundle ────────────────────────────────────────────────────────────

log "Downloading release bundle..."

ARCHIVE_PATH="$WORK_DIR/$ARCHIVE_NAME"
curl -fL --progress-bar -o "$ARCHIVE_PATH" "$ASSET_URL"

echo ""
ok "Download complete"

# ── Verify integrity ───────────────────────────────────────────────────────────

if [[ -n "$CHECKSUM_URL" ]]; then
  log "Verifying integrity..."
  CHECKSUM_FILE="$WORK_DIR/${ARCHIVE_NAME}.sha256"
  curl -fsSL -o "$CHECKSUM_FILE" "$CHECKSUM_URL"

  # sha256sum file has format: "<hash>  <filename>" — adapt for current dir
  EXPECTED_HASH="$(awk '{print $1}' "$CHECKSUM_FILE")"
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL_HASH="$(sha256sum "$ARCHIVE_PATH" | awk '{print $1}')"
  else
    ACTUAL_HASH="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')"
  fi

  if [[ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]]; then
    die "Checksum mismatch! The downloaded file may be corrupted or tampered with.
  Expected: $EXPECTED_HASH
  Actual:   $ACTUAL_HASH"
  fi
  ok "Integrity verified (SHA-256 matches)"
else
  warn "No checksum file found for this release — skipping integrity check"
fi

# ── Unpack ─────────────────────────────────────────────────────────────────────

BUNDLE_DEST="$INSTALL_DIR/$BUNDLE_SLUG"

if [[ -d "$BUNDLE_DEST" ]]; then
  warn "Bundle directory already exists: $BUNDLE_DEST"
  warn "Using existing unpacked bundle."
else
  log "Unpacking bundle to $BUNDLE_DEST..."
  tar -xzf "$ARCHIVE_PATH" -C "$INSTALL_DIR"
  ok "Unpacked"
fi

[[ -f "$BUNDLE_DEST/install.sh" ]] || die "install.sh not found in bundle: $BUNDLE_DEST"
chmod +x "$BUNDLE_DEST/install.sh"

# ── Check for an existing installation to upgrade ──────────────────────────────

EXISTING_RELEASE=""
if [[ -d "$INSTALL_DIR" ]]; then
  # Find a previous bundle directory (different from the one we just unpacked)
  while IFS= read -r candidate; do
    [[ "$candidate" == "$BUNDLE_DEST" ]] && continue
    [[ -f "$candidate/install.sh" && -f "$candidate/.env" ]] || continue
    EXISTING_RELEASE="$candidate"
    break
  done < <(find "$INSTALL_DIR" -maxdepth 1 -name "seclettr-release-*" -type d | sort -r)
fi

# ── Hand off ───────────────────────────────────────────────────────────────────

echo ""
echo -e "${CYN}${BLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}"
if [[ -n "$EXISTING_RELEASE" ]]; then
  echo -e "${CYN}${BLD}  Updating from: $(basename "$EXISTING_RELEASE")${RST}"
  echo -e "${CYN}${BLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}"
  echo ""
  cd "$BUNDLE_DEST"
  exec bash install.sh update --from "$EXISTING_RELEASE" "${PASS_ARGS[@]}"
else
  echo -e "${CYN}${BLD}  Starting fresh installation${RST}"
  echo -e "${CYN}${BLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}"
  echo ""
  cd "$BUNDLE_DEST"
  exec bash install.sh "${PASS_ARGS[@]}"
fi
