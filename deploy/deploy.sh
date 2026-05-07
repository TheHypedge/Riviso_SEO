#!/usr/bin/env bash
# Run on the VPS from /var/www/auto-articles after `git pull`.
# Used by GitHub Actions; safe to run manually: `bash deploy/deploy.sh`
#
# This repo now contains a Next.js frontend + FastAPI backend.
# This script is intentionally conservative: it installs Python deps for the backend,
# builds the frontend, and restarts the systemd units if present.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

git config --global --add safe.directory "$ROOT"

# -------------------------------
# Backend deps (FastAPI)
# -------------------------------
BACKEND_DIR="$ROOT/backend"
if [[ -d "$BACKEND_DIR" ]]; then
  cd "$BACKEND_DIR"
  if [[ ! -d .venv ]]; then
    python3 -m venv .venv
  fi
  # shellcheck source=/dev/null
  source .venv/bin/activate
  python -m pip install --upgrade pip --quiet --disable-pip-version-check
  pip install -r requirements.txt --quiet --disable-pip-version-check
  deactivate || true
  cd "$ROOT"
fi

# -------------------------------
# Frontend build (Next.js)
# -------------------------------
FRONTEND_DIR="$ROOT/frontend"
if [[ -d "$FRONTEND_DIR" ]]; then
  cd "$FRONTEND_DIR"
  npm ci --silent
  npm run build --silent
  cd "$ROOT"
fi

# -------------------------------
# Restart services (if installed)
# -------------------------------
restart_if_present () {
  local unit="$1"
  if sudo systemctl list-unit-files | grep -q "^${unit}"; then
    sudo systemctl restart "$unit"
  fi
}

restart_if_present "auto-articles-backend.service"
restart_if_present "auto-articles-frontend.service"
restart_if_present "nginx.service"

sleep 2
sudo systemctl is-active --quiet auto-articles-backend.service && echo "auto-articles-backend: active" || true
sudo systemctl is-active --quiet auto-articles-frontend.service && echo "auto-articles-frontend: active" || true
