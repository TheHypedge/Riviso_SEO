"""Gemini engine adapter -- uses Google Search grounding so Gemini's answer can
carry real citation URLs (groundingMetadata), not just plain text."""

from __future__ import annotations

import httpx

from app.core.config import settings
from app.services.ai_citation.engine_types import EngineResult

ENGINE = "gemini"
_MODEL = "gemini-2.0-flash"


async def check(prompt: str) -> EngineResult:
    key = (settings.gemini_api_key or "").strip()
    if not key:
        return EngineResult(error="GEMINI_API_KEY is not set")

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{_MODEL}:generateContent"
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "tools": [{"google_search": {}}],
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=30.0)) as client:
            res = await client.post(url, params={"key": key}, json=payload)
        res.raise_for_status()
        data = res.json()
    except Exception as e:
        return EngineResult(error=str(e))

    candidate = ((data.get("candidates") or [None])[0]) or {}
    parts = ((candidate.get("content") or {}).get("parts")) or []
    text = "".join(p.get("text") or "" for p in parts if isinstance(p, dict))

    citations: list[str] = []
    for chunk in (candidate.get("groundingMetadata") or {}).get("groundingChunks") or []:
        uri = ((chunk or {}).get("web") or {}).get("uri")
        if isinstance(uri, str) and uri:
            citations.append(uri)

    return EngineResult(response_text=text, citation_urls=citations)
