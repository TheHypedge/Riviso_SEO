#!/usr/bin/env bash
# Run on the VPS from /var/www/auto-articles after `git pull`.
# Used by GitHub Actions; safe to run manually: `bash deploy/deploy.sh`

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

git config --global --add safe.directory "$ROOT"

if [[ ! -d .venv ]]; then
  echo "Missing .venv — create it: python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt" >&2
  exit 1
fi

# shellcheck source=/dev/null
source .venv/bin/activate

pip install -r requirements.txt --quiet --disable-pip-version-check

sudo systemctl restart auto-articles
sleep 2
sudo systemctl is-active --quiet auto-articles && echo "auto-articles: active"
