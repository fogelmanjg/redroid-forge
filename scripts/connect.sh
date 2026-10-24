#!/bin/bash
# Connects scrcpy to a running redroid-forge instance, picked from a menu built from the
# real API (GET /api/instances) instead of asking you to copy a port by hand every time.
#
# Requires: curl, jq, adb, scrcpy (https://github.com/Genymobile/scrcpy). None of them are
# bundled here -- install them with your distro's package manager, or see
# docs/SCRCPY-TIPS.md if scrcpy itself gives you trouble (audio, hardware decode, bitrate).
#
# Env vars:
#   REDROID_FORGE_URL   Base URL of redroid-forge's API. Default: http://localhost:8080
#                       (run this ON the server, or point it at the server's address).
#   REDROID_FORGE_HOST  Host/IP to actually adb-connect/scrcpy to, if it differs from the
#                       host in REDROID_FORGE_URL (e.g. the API is reached over localhost
#                       but the instance's ADB port is only reachable over a LAN/VPN IP).
#                       Default: derived from REDROID_FORGE_URL.
#   SCRCPY_EXTRA_ARGS   Extra scrcpy flags appended as-is, e.g. SCRCPY_EXTRA_ARGS="--hwdec=disabled".

set -uo pipefail

REDROID_FORGE_URL="${REDROID_FORGE_URL:-http://localhost:8080}"
STATE_DIR="$HOME/.config/redroid-forge-connect"
STATE_FILE="$STATE_DIR/state"
mkdir -p "$STATE_DIR"

for bin in curl jq adb scrcpy; do
  command -v "$bin" >/dev/null 2>&1 || { echo "Missing dependency: $bin" >&2; exit 1; }
done

# Host to adb-connect/scrcpy to: REDROID_FORGE_HOST if set, otherwise the host part of
# REDROID_FORGE_URL (strip scheme and port).
default_host() {
  local no_scheme="${REDROID_FORGE_URL#*://}"
  echo "${no_scheme%%[:/]*}"
}
TARGET_HOST="${REDROID_FORGE_HOST:-$(default_host)}"

fetch_instances() {
  local out
  out="$(curl -s -m 5 "$REDROID_FORGE_URL/api/instances" 2>/dev/null)" || return 1
  [ -n "$out" ] || return 1
  jq -r '.[]? | select(.status=="running") | "\(.name)|\(.adbPort)"' <<<"$out" 2>/dev/null
}

USB_LABEL="USB device (this PC)"

choose() {
  local prompt="$1" default="$2"
  shift 2
  local opts=("$@")
  local i=1 default_idx="" o
  for o in "${opts[@]}"; do
    if [ "$o" = "$default" ]; then echo "  $i) $o (default)" >&2; default_idx=$i
    else echo "  $i) $o" >&2
    fi
    i=$((i + 1))
  done
  local sel
  read -r -p "$prompt" sel
  [ -z "$sel" ] && [ -n "$default_idx" ] && sel=$default_idx
  if ! [[ "$sel" =~ ^[0-9]+$ ]] || [ "$sel" -lt 1 ] || [ "$sel" -gt "${#opts[@]}" ]; then
    return 1
  fi
  echo "${opts[$((sel - 1))]}"
}

INSTANCES_RAW="$(fetch_instances)"
if [ -z "$INSTANCES_RAW" ]; then
  echo "No running instances found at $REDROID_FORGE_URL/api/instances (or the server is unreachable)." >&2
  echo "Set REDROID_FORGE_URL if redroid-forge is not on this machine, e.g.:" >&2
  echo "  REDROID_FORGE_URL=http://192.168.1.50:8080 $0" >&2
fi

LAST_DEVICE=""
LAST_BITRATE="default (8M)"
[ -f "$STATE_FILE" ] && source "$STATE_FILE"

NAMES=()
if [ -n "$INSTANCES_RAW" ]; then
  mapfile -t NAMES < <(cut -d'|' -f1 <<<"$INSTANCES_RAW")
fi
OPTIONS=("${NAMES[@]}" "$USB_LABEL")

echo
echo "Instances:"
SELECTED="$(choose "Pick one: " "$LAST_DEVICE" "${OPTIONS[@]}")" || { echo "Invalid selection."; exit 1; }

if [ "$SELECTED" = "$USB_LABEL" ]; then
  mapfile -t USB_DEVICES < <(adb devices -l 2>/dev/null | tail -n +2 | awk '$1 !~ /:/ && $2=="device" {print $1}')
  if [ ${#USB_DEVICES[@]} -eq 0 ]; then
    echo "No USB devices found (adb devices found none)." >&2
    exit 1
  fi
  echo "USB devices:"
  TARGET="$(choose "Pick one: " "" "${USB_DEVICES[@]}")" || { echo "Invalid selection."; exit 1; }
else
  PORT="$(awk -F'|' -v n="$SELECTED" '$1==n {print $2; exit}' <<<"$INSTANCES_RAW")"
  TARGET="${TARGET_HOST}:${PORT}"
  adb connect "$TARGET" >/dev/null
fi

echo
echo "Video bit rate:"
BITRATE="$(choose "Pick one: " "$LAST_BITRATE" "default (8M)" "4M" "2M" "1M")" || BITRATE="default (8M)"

cat >"$STATE_FILE" <<EOF
LAST_DEVICE="$SELECTED"
LAST_BITRATE="$BITRATE"
EOF

# --audio-codec=aac: redroid has no Opus encoder, and opus is scrcpy's default -- without
# this, audio silently fails (or scrcpy exits with "Failed to initialize audio/opus").
# See docs/SCRCPY-TIPS.md for this and other first-run gotchas (hwdec, codec, bitrate).
SCRCPY_ARGS=(-s "$TARGET" --audio-codec=aac)
[ "$BITRATE" != "default (8M)" ] && SCRCPY_ARGS+=(--video-bit-rate="$BITRATE")
# shellcheck disable=SC2206 # intentional word-splitting of user-provided extra flags
[ -n "${SCRCPY_EXTRA_ARGS:-}" ] && SCRCPY_ARGS+=($SCRCPY_EXTRA_ARGS)

exec scrcpy "${SCRCPY_ARGS[@]}"
