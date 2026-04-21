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

# Verify the expected environment file(s) exist for systemd.
echo "systemd unit (auto-articles):"
sudo systemctl cat auto-articles --no-pager || true

if [[ ! -f "$ROOT/.env" ]]; then
  echo "Missing $ROOT/.env on the server. Restore it (or ensure deploy workflow preserves it) before restarting the service." >&2
  exit 1
fi

ENV_FILES="$(sudo systemctl cat auto-articles --no-pager 2>/dev/null | sed -n 's/^[[:space:]]*EnvironmentFile=//p' | tr ' ' '\n' | sed 's/^-//g' | sed '/^$/d' || true)"
if [[ -n "${ENV_FILES:-}" ]]; then
  while IFS= read -r f; do
    [[ -z "${f:-}" ]] && continue
    f="${f%\"}"; f="${f#\"}"
    if [[ ! -f "$f" ]]; then
      echo "Creating missing EnvironmentFile: $f"
      sudo mkdir -p "$(dirname "$f")"
      sudo install -m 640 "$ROOT/.env" "$f"
    fi
  done <<<"$ENV_FILES"
fi

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
