#!/bin/sh
# hx-fortress — build-from-source installer + enroll entrypoint.
#
# Reaches the same running, enrolled Fortress as the prebuilt `curl … | sh`
# installer, but compiles the binary locally from this checkout instead of
# downloading it. Everything after the build — the one-time <token>, the
# --cloud tunnel URL, and the interactive enroll wizard — is identical to the
# binary installer.
#
# Usage (both values come from workbench Org Settings, same as the binary path):
#
#   ./scripts/install-from-source.sh <token> --cloud <cloud-url>
#
# Prerequisite: Bun (https://bun.sh). This script does not install it for you.
set -eu

INSTALL_DIR="${HOME}/.let/bin"
BIN="${INSTALL_DIR}/hx-fortress"

# --- parse args --------------------------------------------------------
# Positional <token> plus a required `--cloud <url>`, mirroring the CLI's own
# `hx-fortress enroll <token> --cloud <url>` surface.
usage() {
  echo "usage: ./scripts/install-from-source.sh <token> --cloud <url>" >&2
  exit 2
}

TOKEN=""
CLOUD_URL=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --cloud)
      [ "$#" -ge 2 ] || usage
      CLOUD_URL="$2"
      shift 2
      ;;
    --)
      shift
      ;;
    -*)
      echo "hx-fortress: unknown option: $1" >&2
      usage
      ;;
    *)
      [ -z "$TOKEN" ] || usage
      TOKEN="$1"
      shift
      ;;
  esac
done

[ -n "$TOKEN" ] || usage
[ -n "$CLOUD_URL" ] || usage

# --- require Bun -------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  echo "hx-fortress: Bun is required to build from source but was not found." >&2
  echo "Install it, then re-run this script:" >&2
  echo "  curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

# --- build -------------------------------------------------------------
# Run from the repo root regardless of where the script was invoked from.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

echo "Installing dependencies…"
bun install

echo "Building hx-fortress…"
bun run build

# --- install -----------------------------------------------------------
mkdir -p "$INSTALL_DIR"
cp "$REPO_ROOT/dist/hx-fortress" "$BIN"

# Ad-hoc code signature (macOS only). `--sign -` is an ad-hoc signature — the
# only no-cost option for a locally built binary. Without it the kernel can
# kill a freshly compiled unsigned binary with "code signature invalid".
if [ "$(uname -s)" = "Darwin" ]; then
  codesign --force --sign - "$BIN"
fi

echo "Installed hx-fortress to $BIN"

# --- enroll ------------------------------------------------------------
# Hand off to the interactive enroll wizard. Redirect </dev/tty when one is
# available so the wizard can prompt even if this script was piped in.
if (: </dev/tty) 2>/dev/null; then
  exec "$BIN" enroll "$TOKEN" --cloud "$CLOUD_URL" </dev/tty
else
  exec "$BIN" enroll "$TOKEN" --cloud "$CLOUD_URL"
fi
