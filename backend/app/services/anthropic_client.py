"""Claude (Anthropic) text client -- the article-generation alternative to OpenAIClient.chat_json.

Selected with LLM_TEXT_PROVIDER=anthropic. Output is constrained to the same three-key JSON
object the OpenAI path returns, so everything downstream (sanitizers, link injection) is shared.
"""

from __future__ import annotations

import json
from typing import Any

import anthropic

from app.core.config import settings

ARTICLE_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "article_markdown": {"type": "string"},
        "meta_title": {"type": "string"},
        "meta_description": {"type": "string"},
    },
    "required": ["article_markdown", "meta_title", "meta_description"],
    "additionalProperties": False,
}


class AnthropicClient:
    def __init__(self) -> None:
        key = (settings.anthropic_api_key or "").strip()
        if not key:
            raise RuntimeError("ANTHROPIC_API_KEY is not set")
        # Long articles at high effort can take minutes; the SDK retries 429/5xx itself.
        self._client = anthropic.AsyncAnthropic(api_key=key, timeout=900.0, max_retries=2)

    async def chat_json(self, *, model: str, system: str, user: str) -> dict[str, Any]:
        async with self._client.beta.messages.stream(
            model=model,
            max_tokens=32000,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_config={"effort": "high", "format": {"type": "json_schema", "schema": ARTICLE_JSON_SCHEMA}},
            # On a safety decline the API re-runs the request on Anthropic's recommended model.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        ) as stream:
            msg = await stream.get_final_message()
        if msg.stop_reason == "refusal":
            raise RuntimeError("Claude declined to write this article")
        if msg.stop_reason == "max_tokens":
            raise RuntimeError("Claude hit the output limit before finishing the article")
        text = next((b.text for b in msg.content if b.type == "text"), "")
        try:
            obj = json.loads(text)
        except Exception as e:
            raise RuntimeError(f"Model did not return valid JSON: {e}") from e
        if not isinstance(obj, dict):
            raise RuntimeError("Model JSON response is not an object")
        return obj
