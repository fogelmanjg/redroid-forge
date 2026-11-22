#!/bin/bash
# Installs the redroid-forge scrcpy launcher for the CURRENT user (no root needed): the script in
# ~/.local/bin, a hidden .desktop entry that handles scrcpy-redroid:// links, and a config file if
# you had none. Run it from the folder where you downloaded the files:
#
#   bash install.sh
#
# Then press "Test local scrcpy" in redroid-forge. Uninstall: bash install.sh --uninstall
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$HOME/.local/bin"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/redroid-forge-launcher"
DESKTOP=scrcpy-redroid-launcher.desktop
MIME=x-scheme-handler/scrcpy-redroid

if [ "${1:-}" = --uninstall ]; then
    rm -f "$BIN_DIR/scrcpy-redroid-launcher" "$APP_DIR/$DESKTOP"
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APP_DIR" 2>/dev/null || true
    echo "Uninstalled. Your config in $CONF_DIR was kept (delete it by hand if you want)."
    echo "Remember to turn the launcher off in redroid-forge (it cannot tell by itself)."
    exit 0
fi

[ "$(id -u)" -ne 0 ] || { echo "Run this as your normal user, not root: the handler is per user." >&2; exit 1; }
[ -f "$HERE/scrcpy-redroid-launcher" ] || { echo "scrcpy-redroid-launcher not found next to install.sh -- download both files." >&2; exit 1; }

missing=()
command -v adb >/dev/null 2>&1 || missing+=(adb)
command -v scrcpy >/dev/null 2>&1 || missing+=(scrcpy)
command -v xdg-mime >/dev/null 2>&1 || missing+=(xdg-utils)
command -v update-desktop-database >/dev/null 2>&1 || missing+=(desktop-file-utils)
if [ "${#missing[@]}" -gt 0 ]; then
    echo "Missing: ${missing[*]}"
    echo "  Debian/Ubuntu: sudo apt install ${missing[*]}"
    echo "  (desktop-file-utils matters: without it browsers may not see the handler even though it is registered.)"
    read -rp "Install the launcher anyway? [y/N] " r
    [ "$r" = y ] || [ "$r" = Y ] || exit 1
fi

mkdir -p "$BIN_DIR" "$APP_DIR" "$CONF_DIR"
install -m 0755 "$HERE/scrcpy-redroid-launcher" "$BIN_DIR/scrcpy-redroid-launcher"
cat >"$APP_DIR/$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=redroid-forge scrcpy launcher
Comment=Opens scrcpy-redroid:// links from redroid-forge
Exec=$BIN_DIR/scrcpy-redroid-launcher %u
Terminal=false
NoDisplay=true
MimeType=$MIME;
EOF
if [ ! -f "$CONF_DIR/config" ] && [ -f "$HERE/config.example" ]; then
    install -m 0644 "$HERE/config.example" "$CONF_DIR/config"
    echo "Config created: $CONF_DIR/config"
fi
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APP_DIR" 2>/dev/null || true
command -v xdg-mime >/dev/null 2>&1 && xdg-mime default "$DESKTOP" "$MIME"

echo "Installed: $BIN_DIR/scrcpy-redroid-launcher"
echo "Handler for $MIME: $(xdg-mime query default "$MIME" 2>/dev/null || echo '?')"
echo
echo "Now press \"Test local scrcpy\" in redroid-forge. The first time, the browser asks whether to open"
echo "the link with this program: accept (and tick \"always\" if it offers it)."
