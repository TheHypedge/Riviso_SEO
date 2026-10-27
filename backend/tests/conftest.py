"""Test-wide guard: tests must never reach a real MongoDB.

database.py loads the repo-root .env (the production Atlas URI) on import, and several
storage.py writers (e.g. insert_article) always go to Mongo regardless of
FORCE_JSON_STORAGE. Pointing the URI at a closed local port before anything imports
storage makes any accidental DB access fail fast instead of writing to production.
load_dotenv() does not override variables that are already set.
"""

import os

os.environ["MONGODB_URI"] = "mongodb://127.0.0.1:9/riviso-tests-blocked?serverSelectionTimeoutMS=500"
os.environ["MONGODB_DB_NAME"] = "riviso_tests_blocked"
os.environ.setdefault("FORCE_JSON_STORAGE", "1")
# The local backend/.env may carry Razorpay test keys with ENVIRONMENT=production; the
# production boot check refuses those (by design). Tests never take real payments, so opt
# out explicitly here -- test_razorpay_live_hardening.py covers the check itself.
os.environ.setdefault("RAZORPAY_ALLOW_TEST_KEYS", "1")
