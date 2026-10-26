"""Regression: prod kept OPENAI_IMAGE_MODEL=gpt-image-1 in its .env after OpenAI shut that
model down (2026-10-23), so every featured and inner image failed with "model does not
exist". Settings now swaps the retired name for gpt-image-2."""

from __future__ import annotations

import os

os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")

from app.core.config import Settings


def _image_model(monkeypatch, value: str) -> str:
    monkeypatch.setenv("OPENAI_IMAGE_MODEL", value)
    return Settings(_env_file=None).openai_image_model


def test_retired_model_from_env_is_replaced(monkeypatch):
    assert _image_model(monkeypatch, "gpt-image-1") == "gpt-image-2"
    assert _image_model(monkeypatch, '"gpt-image-1"') == "gpt-image-2"


def test_other_models_pass_through(monkeypatch):
    assert _image_model(monkeypatch, "gpt-image-2") == "gpt-image-2"
    assert _image_model(monkeypatch, "gpt-image-1.5") == "gpt-image-1.5"
