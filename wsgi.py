"""
Gunicorn WSGI entrypoint.

Why this exists:
- Avoids module name collisions with 'app' on some servers/environments.
- Keeps the import surface minimal and explicit for systemd/Procfile.
"""

from app import app  # noqa: F401

