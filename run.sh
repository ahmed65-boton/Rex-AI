#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(realpath "$0")")"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required to build Rex AI. Install the current Node.js LTS release." >&2
  exit 1
fi
if [[ ! -x node_modules/.bin/esbuild ]]; then
  echo "[0/4] Installing frontend build dependency (ESBuild)..."
  npm install --no-audit --no-fund
fi
echo "[0/4] Building frontend with ESBuild..."
npm run build

PYTHON="$(command -v python3 || command -v python || true)"
if [[ -z "$PYTHON" ]]; then echo "Python 3.10+ is required." >&2; exit 1; fi
"$PYTHON" - <<'PY'
import sys
if sys.version_info < (3, 10): raise SystemExit("Python 3.10+ is required.")
PY
if [[ ! -x .venv/bin/python ]]; then "$PYTHON" -m venv .venv; fi
.venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt
exec .venv/bin/python server.py
