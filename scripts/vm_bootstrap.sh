#!/usr/bin/env bash
# Run once on a fresh Ubuntu VM after cloning the repo (adjust APP_DIR).
set -euo pipefail
APP_DIR="${APP_DIR:-/var/www/auto-articles}"
cd "$APP_DIR"

sudo apt-get update -y
sudo apt-get install -y python3-venv python3-pip nginx certbot python3-certbot-nginx git

python3 -m venv .venv
. .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

sudo mkdir -p "$APP_DIR/data/article_images" "$APP_DIR/.flask_session"
sudo chown -R "$USER:www-data" "$APP_DIR/data" "$APP_DIR/.flask_session" || true

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "Create $APP_DIR/.env with at least: FLASK_SECRET_KEY, MONGODB_URI, MONGODB_DB_NAME, OPENAI_API_KEY (or your provider keys)"
  exit 1
fi

echo "Next: install deploy/systemd/auto-articles.service.example and deploy/nginx config, then: sudo certbot --nginx -d your-domain.com"
