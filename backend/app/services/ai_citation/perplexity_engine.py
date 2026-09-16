"""Perplexity engine adapter -- Perplexity's API is OpenAI-chat-compatible and, unlike
ChatGPT, browses the live web and returns citation URLs alongside the answer."""

from __future__ import annotations

import httpx

from app.core.config import settings
from app.services.ai_citation.engine_types import EngineResult

ENGINE = "perplexity"
_MODEL = "sonar"


async def check(prompt: str) -> EngineResult:
    key = (settings.perplexity_api_key or "").strip()
    if not key:
        return EngineResult(error="PERPLEXITY_API_KEY is not set")

    payload = {"model": _MODEL, "messages": [{"role": "user", "content": prompt}]}
    headers = {"authorization": f"Bearer {key}", "content-type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=30.0)) as client:
            res = await client.post("https://api.perplexity.ai/chat/completions", headers=headers, json=payload)
        res.raise_for_status()
        data = res.json()
    except Exception as e:
        return EngineResult(error=str(e))

    text = (((data.get("choices") or [None])[0] or {}).get("message") or {}).get("content") or ""
    citations = [c for c in (data.get("citations") or []) if isinstance(c, str)]
    return EngineResult(response_text=text, citation_urls=citations)
