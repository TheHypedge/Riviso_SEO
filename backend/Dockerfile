# API container — run behind a reverse proxy with TLS in production.
#
# Multi-worker note: use only one worker process per container if ENABLE_SCHEDULER=1 (in-process loop).
# For horizontal scaling, set ENABLE_SCHEDULER=0 here and run scheduling in a separate worker deployment.

FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN useradd --create-home --system --uid 10001 appuser

COPY backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Headless Chromium for the AI Citation Tracking Google AI Overview scraper
# (app/services/ai_citation/google_ai_overview_engine.py) -- Google only renders
# that block client-side via JS, so a plain httpx fetch (like the rest of this
# repo's scraping) can never read it; a real browser is required. `--with-deps`
# apt-installs Chromium's system libraries as root, before USER appuser below.
# This adds real image size (~300-400MB) to every service built from this one
# shared Dockerfile (api/worker/scheduler/serp-refresh/seo-crawl/ai-citation),
# not just the ai-citation worker that actually uses it -- accepted deliberately
# to keep the single-Dockerfile convention this repo already uses for every
# other background worker, rather than adding a second Dockerfile for one engine.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN playwright install --with-deps chromium

COPY backend/app /app/app
COPY backend/.env.example /app/.env.example
COPY backend/wordpress_plugin /app/backend/wordpress_plugin
COPY backend/newrelic.ini /app/newrelic.ini
COPY backend/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Transitional: reuse existing modules while migrating to new architecture.
COPY storage.py /app/storage.py
COPY database.py /app/database.py

# Pre-create the data directory so named volumes (app_data) initialize with correct ownership.
RUN mkdir -p /app/data/article_images && chown -R appuser:appuser /app /ms-playwright

USER appuser

EXPOSE 8000

ENTRYPOINT ["/app/docker-entrypoint.sh"]

# --proxy-headers + --forwarded-allow-ips: required behind nginx/load balancers so
# request.client.host (rate limiting, audit logs) reflects the real client and not
# the proxy IP. Tighten --forwarded-allow-ips=<comma list of proxy IPs> for stricter setups.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
