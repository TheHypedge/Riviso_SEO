"""ChatGPT engine adapter -- reuses OPENAI_API_KEY (same key article generation uses)."""

from __future__ import annotations

from app.core.config import settings
from app.services.ai_citation.engine_types import EngineResult
from app.services.openai_client import OpenAIClient

ENGINE = "chatgpt"


async def check(prompt: str) -> EngineResult:
    try:
        client = OpenAIClient()
    except RuntimeError as e:
        return EngineResult(error=str(e))
    try:
        text = await client.chat_text(model=settings.openai_text_model, user=prompt)
    except Exception as e:  # transport/HTTP errors -- surface as a failed cell, not a crash
        return EngineResult(error=str(e))
    # ChatGPT (no browsing) never returns grounding citation URLs.
    return EngineResult(response_text=text, citation_urls=[])
