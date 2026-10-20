"""Technical Audit run: per-strategy duration, screenshot stored as URL only, upload
failure never fails the audit. PSI, image storage and Mongo are all mocked."""

import asyncio
import base64
import copy
import json
from pathlib import Path

from app.api.routes import site_audit_technical as route

RAW = json.loads((Path(__file__).parent / "fixtures" / "psi" / "mobile.json").read_text())
JPEG = b"\xff\xd8\xff\xe0" + b"1" * 64


class _Store:
    def __init__(self):
        self.saved = []

    def save_technical_audit_run(self, run):
        self.saved.append(run)


def _raw_with_screenshot():
    r = copy.deepcopy(RAW)
    r["lighthouseResult"]["audits"]["final-screenshot"]["details"]["data"] = "data:image/jpeg;base64," + base64.b64encode(JPEG).decode()
    return r


def _run(monkeypatch, upload):
    store = _Store()

    async def fake_fetch(*, url, strategy):
        return _raw_with_screenshot()

    monkeypatch.setattr(route, "fetch_pagespeed_result", fake_fetch)
    monkeypatch.setattr(route, "upload_image_bytes", upload)
    monkeypatch.setattr(route, "get_legacy_storage_module", lambda: store)
    asyncio.run(route._execute_technical_audit(project_id="p1", url="https://example.com/"))
    return store


def test_run_stores_duration_and_screenshot_url_only(monkeypatch):
    calls = []

    def upload(data, *, folder, public_id):
        calls.append((data, folder, public_id))
        return {"secure_url": f"https://res.cloudinary.com/x/{public_id}.jpg", "public_id": public_id}

    store = _run(monkeypatch, upload)
    run = store.saved[0]
    for strategy in ("mobile", "desktop"):
        r = run[strategy]
        assert isinstance(r["run_duration_ms"], int) and r["run_duration_ms"] >= 0
        assert r["screenshot_status"] == "stored" and r["screenshot_url"].endswith(f"{run['id']}-{strategy}.jpg")
    assert [c[0] for c in calls] == [JPEG, JPEG] and calls[0][1] == "technical-audit/p1"
    assert "base64" not in json.dumps(run)


def test_screenshot_upload_failure_does_not_fail_the_audit(monkeypatch):
    store = _run(monkeypatch, lambda data, **kw: None)
    assert store.saved and store.saved[0]["mobile"]["screenshot_status"] == "unavailable"
    assert store.saved[0]["mobile"]["screenshot_url"] is None


def test_upload_exception_is_contained(monkeypatch):
    def boom(data, **kw):
        raise RuntimeError("cloudinary down")

    store = _run(monkeypatch, boom)
    assert store.saved[0]["desktop"]["screenshot_status"] == "unavailable"
