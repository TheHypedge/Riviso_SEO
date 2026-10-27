"""Plugin self-update channel: per-site HMAC token gates the release manifest and the ZIP."""

import os

os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")

import pytest
from fastapi import HTTPException

import app.api.routes.wordpress as wpr
from app.services import wordpress_plugin_packager as pk


def test_token_roundtrip_and_tampering():
    tok = pk.make_update_token("proj-123")
    assert pk.update_token_project_id(tok) == "proj-123"
    pid, _, sig = tok.rpartition(".")
    assert pk.update_token_project_id(f"other-proj.{sig}") is None
    assert pk.update_token_project_id(f"{pid}.{'0' * 40}") is None
    assert pk.update_token_project_id("") is None
    assert pk.update_token_project_id("no-dot") is None


def test_token_matches_plugin_format():
    import re

    # Mirrors handle_update_token()'s regex in connector.php.
    assert re.fullmatch(r"[A-Za-z0-9_-]{1,100}\.[a-f0-9]{40}", pk.make_update_token("3f2a9c1e-77aa-4b1e-9d0e-5c1a2b3c4d5e"))


class _St:
    def get_project_by_id(self, pid):
        return {"id": pid} if pid == "live" else None


def test_route_guard_requires_existing_project(monkeypatch):
    monkeypatch.setattr(wpr, "get_legacy_storage_module", lambda: _St())
    assert wpr._project_for_update_token(pk.make_update_token("live")) == "live"
    for bad in (pk.make_update_token("deleted"), "garbage", ""):
        with pytest.raises(HTTPException) as e:
            wpr._project_for_update_token(bad)
        assert e.value.status_code == 404


def test_shipped_plugin_is_canonical_and_versioned():
    assert pk.resolve_plugin_source_dir().parent.parent.name == "backend"
    data, _ = pk.build_plugin_zip_bytes()
    pk.validate_plugin_zip(data)
    assert pk.get_plugin_version() == "0.7.0"
