#!/usr/bin/env bash
# Run on the VPS from /var/www/auto-articles after `git pull`.
# Used by GitHub Actions; safe to run manually: `bash deploy/deploy.sh`

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

git config --global --add safe.directory "$ROOT"

if [[ ! -d .venv ]]; then
  echo "Missing .venv — creating virtualenv"
  # Ensure venv module exists (Ubuntu may require python3-venv).
  if ! python3 -m venv .venv >/dev/null 2>&1; then
    echo "python3 venv not available; installing python3-venv"
    sudo -n apt-get update -y
    sudo -n apt-get install -y python3-venv
    python3 -m venv .venv
  fi
fi

# shellcheck source=/dev/null
source .venv/bin/activate

python -m pip install --upgrade pip --quiet --disable-pip-version-check
pip install -r requirements.txt --quiet --disable-pip-version-check

if ! sudo systemctl restart auto-articles; then
  echo "auto-articles.service failed to restart. Diagnostics:" >&2
  sudo systemctl status auto-articles --no-pager || true
  sudo journalctl -xeu auto-articles --no-pager -n 200 || true
  df -h || true
  free -m || true
  exit 1
fi
sleep 2
sudo systemctl is-active --quiet auto-articles && echo "auto-articles: active"
