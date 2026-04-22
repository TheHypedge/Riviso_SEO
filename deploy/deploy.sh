#!/usr/bin/env bash
# Run on the VPS from /var/www/auto-articles after `git pull`.
# Used by GitHub Actions; safe to run manually: `bash deploy/deploy.sh`
# Does not modify .env (CI restores it before this runs).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

git config --global --add safe.directory "$ROOT"

if [[ -d .venv ]]; then
  # shellcheck source=/dev/null
  source .venv/bin/activate
elif [[ -d venv ]]; then
  # shellcheck source=/dev/null
  source venv/bin/activate
else
  echo "Missing Python venv — create one: python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt" >&2
  exit 1
fi

python -m pip install --upgrade pip --quiet --disable-pip-version-check
pip install -r requirements.txt --quiet --disable-pip-version-check

if ! sudo systemctl restart auto-articles; then
  echo "auto-articles.service failed to restart." >&2
  sudo systemctl status auto-articles --no-pager || true
  sudo journalctl -xeu auto-articles --no-pager -n 120 || true
  exit 1
fi
sleep 2
sudo systemctl is-active --quiet auto-articles && echo "auto-articles: active"
