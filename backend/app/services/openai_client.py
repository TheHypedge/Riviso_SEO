from __future__ import annotations

import base64
import json
from typing import Any

import httpx

from app.core.config import settings


class OpenAIClient:
    def __init__(self) -> None:
        if not (settings.openai_api_key or "").strip():
            raise RuntimeError("OPENAI_API_KEY is not set")
        self._key = settings.openai_api_key.strip()

    def _headers(self) -> dict[str, str]:
        return {
            "authorization": f"Bearer {self._key}",
            "content-type": "application/json",
        }

    async def chat_json(self, *, model: str, system: str, user: str) -> dict[str, Any]:
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0.6,
            "response_format": {"type": "json_object"},
        }
        # Long SEO articles can exceed 60s; keep below client/proxy long-operation budgets (see frontend LONG_API_TIMEOUT_MS).
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=180.0)) as client:
            res = await client.post("https://api.openai.com/v1/chat/completions", headers=self._headers(), json=payload)
        res.raise_for_status()
        data = res.json()
        content = (
            (((data.get("choices") or [None])[0] or {}).get("message") or {}).get("content") or ""
        )
        try:
            obj = json.loads(content)
        except Exception as e:
            raise RuntimeError(f"Model did not return valid JSON: {e}") from e
        if not isinstance(obj, dict):
            raise RuntimeError("Model JSON response is not an object")
        return obj

    async def generate_image_url(self, *, model: str, prompt: str) -> str | None:
        payload = {
            "model": model,
            "prompt": prompt,
            "size": "1024x1024",
            # Most current image models return base64 in `b64_json`.
        }
        # Image generations can be slow for high-quality renders.
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=300.0)) as client:
            res = await client.post("https://api.openai.com/v1/images/generations", headers=self._headers(), json=payload)
        res.raise_for_status()
        data = res.json()
        items = data.get("data") or []
        if isinstance(items, list) and items:
            first = items[0] or {}
            url = first.get("url")
            if isinstance(url, str) and url.strip():
                return url.strip()
            b64 = first.get("b64_json")
            if isinstance(b64, str) and b64.strip():
                # Basic validation; if invalid base64, just ignore.
                try:
                    _ = base64.b64decode(b64, validate=True)
                except Exception:
                    return None
                return f"data:image/png;base64,{b64.strip()}"
        return None

