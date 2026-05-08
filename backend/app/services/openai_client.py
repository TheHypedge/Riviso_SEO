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

    async def embed_batch(
        self,
        *,
        model: str,
        inputs: list[str],
        timeout_s: float = 8.0,
    ) -> list[list[float]]:
        """
        Return embeddings for each input in the same order, in a single HTTP call.

        Used by :class:`app.services.cluster_validation.ClusterValidationService`
        for cosine-similarity intent overlap detection. We keep this method
        side-effect free (no logging of payload contents) so it's safe to call
        from request paths under tight latency budgets — the OpenAI batch API
        comfortably handles ~500 short strings per call within ~150ms.

        Returns ``[]`` on transport / decode failure rather than raising, so
        validators can degrade to exact-match-only without breaking the response.
        """
        if not inputs:
            return []
        # OpenAI's embeddings endpoint caps at 2048 inputs per request; we stay
        # well below that — the validator batches client-side before calling.
        payload = {"model": model, "input": [s[:2000] for s in inputs]}
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(timeout_s, read=timeout_s)
            ) as client:
                res = await client.post(
                    "https://api.openai.com/v1/embeddings",
                    headers=self._headers(),
                    json=payload,
                )
            res.raise_for_status()
            data = res.json()
        except Exception:
            return []
        items = data.get("data") or []
        if not isinstance(items, list):
            return []
        out: list[list[float]] = []
        for it in items:
            vec = (it or {}).get("embedding") if isinstance(it, dict) else None
            if isinstance(vec, list) and vec and all(isinstance(v, (int, float)) for v in vec):
                out.append([float(v) for v in vec])
            else:
                out.append([])
        return out

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

