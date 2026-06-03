# Process types for Procfile-based platforms (Heroku/foreman/honcho).
# Mirrors the docker-compose topology (I3.1): the API runs no in-process
# scheduler/worker; those run as dedicated process types so a long generation
# or publish never blocks request handling.
#
# The supported backend is the FastAPI app (backend/app.main:app); the legacy
# Flask app is disabled in production (S0.5). Run exactly ONE scheduler instance.
web: ENABLE_SCHEDULER=0 ENABLE_GENERATION_WORKER=0 bash -lc 'cd backend && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips=*'
worker: ENABLE_GENERATION_WORKER=1 ENABLE_SCHEDULER=0 bash -lc 'cd backend && python -m app.run_background'
scheduler: ENABLE_SCHEDULER=1 ENABLE_GENERATION_WORKER=0 bash -lc 'cd backend && python -m app.run_background'
