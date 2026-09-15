#!/bin/sh
# Opt-in New Relic APM wrapper (I5.8), shared by the api/worker/scheduler
# containers (they all build from this image; docker-compose overrides CMD).
#
# newrelic-admin run-program must wrap the interpreter *before* any app module
# imports so the agent's import hooks can patch FastAPI/Starlette, httpx,
# pymongo, redis, etc. Doing this here (not inside app/main.py) keeps the
# agent out of the import path entirely when it's not configured -- no
# NEW_RELIC_LICENSE_KEY means this is a plain `exec "$@"`, identical to the
# image's behaviour before New Relic was added.
set -e

if [ -n "$NEW_RELIC_LICENSE_KEY" ]; then
    exec newrelic-admin run-program "$@"
fi

exec "$@"
