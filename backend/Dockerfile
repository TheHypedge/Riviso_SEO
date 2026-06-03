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

COPY backend/app /app/app
COPY backend/.env.example /app/.env.example
COPY backend/wordpress_plugin /app/backend/wordpress_plugin

# Transitional: reuse existing modules while migrating to new architecture.
COPY storage.py /app/storage.py
COPY database.py /app/database.py

# Pre-create the data directory so named volumes (app_data) initialize with correct ownership.
RUN mkdir -p /app/data/article_images && chown -R appuser:appuser /app

USER appuser

EXPOSE 8000

# --proxy-headers + --forwarded-allow-ips: required behind nginx/load balancers so
# request.client.host (rate limiting, audit logs) reflects the real client and not
# the proxy IP. Tighten --forwarded-allow-ips=<comma list of proxy IPs> for stricter setups.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
