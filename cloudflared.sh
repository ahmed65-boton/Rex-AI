#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(realpath "$0")")"
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Linux-x86_64) TARGET=linux-amd64 ;;
  Linux-aarch64|Linux-arm64) TARGET=linux-arm64 ;;
  Darwin-x86_64) TARGET=darwin-amd64 ;;
  Darwin-arm64) TARGET=darwin-arm64 ;;
  *) echo "Unsupported platform: $OS $ARCH" >&2; exit 1 ;;
esac
if command -v cloudflared >/dev/null 2>&1; then exec cloudflared tunnel --url http://127.0.0.1:3456; fi
BIN="cloudflared"
if [[ -x "$BIN" ]]; then exec "./$BIN" tunnel --url http://127.0.0.1:3456; fi
URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-$TARGET"
if command -v curl >/dev/null 2>&1; then curl -fL "$URL" -o "$BIN"; elif command -v wget >/dev/null 2>&1; then wget -O "$BIN" "$URL"; else echo "Install curl or wget first." >&2; exit 1; fi
chmod +x "$BIN"
exec "./$BIN" tunnel --url http://127.0.0.1:3456
