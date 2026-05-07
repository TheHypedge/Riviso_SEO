"""
Validate user-authored writing prompts so they stay on topic.

Image prompts are no longer user-authored for generation — see ``image_prompts`` routes.

All public helpers raise :class:`fastapi.HTTPException` (HTTP 400) with a human-readable
reason on failure, except ``assert_writing_prompt_allowed`` which raises ``ValueError``
for background workers (scheduler).
"""

from __future__ import annotations

import re

from fastapi import HTTPException

from app.services.seo_guardrails import SCOPE_VIOLATION_MESSAGE, validate_seo_writing_domain

__all__ = [
    "PromptValidationError",
    "validate_writing_prompt",
    "assert_writing_prompt_allowed",
    "validate_image_prompt",
]


class PromptValidationError(ValueError):
    """Raised when a prompt fails validation — converted to HTTP 400 by the API."""


_MIN_CHARS = 5
_MAX_CHARS = 100_000

_JAILBREAK_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE) for p in (
        r"\bignore\s+(?:all|any|the|previous|prior|above)\s+(?:instruction|rule|prompt|message|content|directive)s?\b",
        r"\bdisregard\s+(?:all|any|the|previous|prior|above)\s+(?:instruction|rule|prompt|message)s?\b",
        r"\b(?:override|bypass|circumvent)\s+(?:the\s+)?(?:system|safety|content)\s*(?:prompt|filter|policy|guard|rules?)\b",
        r"\byou\s+are\s+(?:no\s+longer|not)\s+(?:an?\s+)?(?:ai|assistant|content\s*writer|riviso)\b",
        r"\byou\s+(?:are\s+now|will\s+now\s+be|must\s+now\s+act\s+as)\b",
        r"\b(?:act|behave|pretend|roleplay|role-?play)\s+as\s+(?:a|an|the)\s+(?:hacker|jailbroken|developer\s*mode|dan|do[\s-]*anything[\s-]*now|unfiltered|uncensored)\b",
        r"\bjailbreak(?:ing)?\b",
        r"\bdeveloper\s+mode\b",
        r"\bdo\s+anything\s+now\b",
        r"\bsystem\s*prompt\s*[:=]",
        r"\b<\s*\|?\s*(?:system|user|assistant)\s*\|?\s*>",
        r"\b#{0,3}\s*system\s*[:\-]",
    )
)

_HARMFUL_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE) for p in (
        r"\b(?:child|minor|underage)\s*(?:porn|sexual|nudity|nude)",
        r"\bcsam\b",
        r"\bbomb[\s-]*making\b",
        r"\bbioweapon\b",
        r"\bhow\s+to\s+(?:make|build|synthesize)\s+(?:a\s+)?(?:bomb|weapon|virus|nerve\s+agent)\b",
    )
)

_WRITING_TOPIC_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE) for p in (
        r"\barticle\b",
        r"\bblog(?:\s*post)?\b",
        r"\bcontent\b",
        r"\bcopy\b",
        r"\bwrite\b",
        r"\bwriting\b",
        r"\bwritten\b",
        r"\bdraft\b",
        r"\bauthor\b",
        r"\bcompose\b",
        r"\beditor(?:ial)?\b",
        r"\bnewsletter\b",
        r"\bessay\b",
        r"\bguide\b",
        r"\btutorial\b",
        r"\bparagraphs?\b",
        r"\bheadings?\b",
        r"\bintroduction\b",
        r"\bconclusion\b",
        r"\bseo\b",
        r"\bkeyphrase\b",
        r"\bkeywords?\b",
        r"\bmarkdown\b",
        r"\bbody\b",
    )
)

_WRITING_OFFTOPIC_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\b(?:generate|create|produce|render|draw|paint|design|make)\s+(?:an?\s+|the\s+)?(?:image|picture|photo|photograph|illustration|painting|render|sketch|diagram|infographic|logo|banner|wallpaper|artwork|graphic)s?\b", re.IGNORECASE),
     "Writing prompts cannot ask for image generation; featured images are built automatically from your focus keyphrase and niche."),
    (re.compile(r"\b(?:image|picture|photo)\s+prompt\b", re.IGNORECASE),
     "Writing prompts cannot ask for image generation; featured images are built automatically from your focus keyphrase and niche."),
    (re.compile(r"\b(?:write|generate|produce|return)\s+(?:python|javascript|typescript|java|c\+\+|c#|go|rust|sql|html|css|bash|shell)\s+code\b", re.IGNORECASE),
     SCOPE_VIOLATION_MESSAGE),
    (re.compile(r"\b(?:write|generate)\s+(?:a\s+)?(?:program|script|function|class)\b", re.IGNORECASE),
     SCOPE_VIOLATION_MESSAGE),
    (re.compile(r"\b(?:generate|produce|return)\s+(?:an?\s+)?(?:video|audio|song|music|podcast|voice[\s-]*over)\b", re.IGNORECASE),
     SCOPE_VIOLATION_MESSAGE),
    (re.compile(r"\bsolve\s+(?:this|the)\s+(?:math|equation|captcha)\b", re.IGNORECASE),
     SCOPE_VIOLATION_MESSAGE),
    (re.compile(r"\b(?:write|compose|create)\s+(?:a\s+)?(?:poem|poetry|sonnet|haiku|limerick|rap\s+lyrics?)\b", re.IGNORECASE),
     SCOPE_VIOLATION_MESSAGE),
    (re.compile(r"\b(?:casual\s+conversation|small\s+talk|chat\s+about\s+anything|tell\s+me\s+your\s+opinion\s+on)\b", re.IGNORECASE),
     SCOPE_VIOLATION_MESSAGE),
)


_IMAGE_TOPIC_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE) for p in (
        r"\bimage\b",
        r"\bpicture\b",
        r"\bphoto(?:graph)?\b",
        r"\billustration\b",
        r"\brender(?:ing)?\b",
        r"\bartwork\b",
        r"\bgraphic\b",
        r"\bbanner\b",
        r"\bcover\b",
        r"\bfeatured\b",
        r"\bvisual\b",
        r"\bscene\b",
        r"\bcomposition\b",
        r"\blighting\b",
        r"\bbackground\b",
        r"\bportrait\b",
        r"\blandscape\b",
        r"\bcinematic\b",
        r"\brealistic\b",
        r"\bstyle\b",
        r"\bdepict\b",
        r"\bshot\b",
        r"\bcamera\b",
    )
)

_IMAGE_OFFTOPIC_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\b(?:write|generate|produce|draft|compose|create)\s+(?:an?\s+|the\s+)?(?:article|blog\s*post|essay|paragraph|guide|tutorial|content|copy|newsletter|story\s+article|press\s+release)(?!\s+(?:image|photo|picture|illustration|graphic|banner|header|cover|featured|topic|thumbnail|hero|visual|art))\b", re.IGNORECASE),
     "Image prompts cannot ask for article writing. Use the Writing Prompt section for article instructions."),
    (re.compile(r"\b(?:write|generate|produce)\s+(?:meta\s*title|meta\s*description|seo\s*meta)\b", re.IGNORECASE),
     "Image prompts cannot generate SEO metadata. Use the Writing Prompt section for that."),
    (re.compile(r"\b(?:write|generate|produce|return)\s+(?:python|javascript|typescript|java|c\+\+|c#|go|rust|sql|html|css|bash|shell)\s+code\b", re.IGNORECASE),
     "Image prompts must describe an image, not produce source code."),
    (re.compile(r"\b(?:write|generate)\s+(?:a\s+)?(?:program|script|function|class)\b", re.IGNORECASE),
     "Image prompts must describe an image, not produce source code."),
    (re.compile(r"\b(?:generate|produce)\s+(?:an?\s+)?(?:video|audio|song|music|podcast|voice[\s-]*over)\b", re.IGNORECASE),
     "Image prompts must describe an image, not multimedia output."),
)


def _http_400(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


def _check_common_valueerror(text: str) -> None:
    s = (text or "").strip()
    if len(s) < _MIN_CHARS:
        raise ValueError("Prompt is too short. Please add more detail (at least 5 characters).")
    if len(s) > _MAX_CHARS:
        raise ValueError("Prompt is too long. Please shorten it under 100,000 characters.")
    for pat in _JAILBREAK_PATTERNS:
        if pat.search(s):
            raise ValueError(
                "Prompt contains instructions that try to override the system rules. "
                "Please remove jailbreak / role-override phrases and keep the prompt focused on the task."
            )
    for pat in _HARMFUL_PATTERNS:
        if pat.search(s):
            raise ValueError("Prompt contains disallowed content and was rejected.")


def _has_any(patterns: tuple[re.Pattern[str], ...], text: str) -> bool:
    return any(p.search(text) for p in patterns)


def assert_writing_prompt_allowed(text: str, *, user_id: str | None = None) -> None:
    """
    Validate a writing prompt for background generation (scheduler). Raises ``ValueError``.
    """
    s = (text or "").strip()
    _check_common_valueerror(s)
    for pat, msg in _WRITING_OFFTOPIC_PATTERNS:
        if pat.search(s):
            raise ValueError(msg)
    if not _has_any(_WRITING_TOPIC_PATTERNS, s):
        raise ValueError(
            "Writing prompts must clearly instruct the AI to write article content. "
            "Include words like 'article', 'blog post', 'write', 'content', 'paragraphs', or 'headings'."
        )
    validate_seo_writing_domain(s, user_id=user_id)


def validate_writing_prompt(text: str, *, user_id: str | None = None) -> None:
    """Validate a project *writing* prompt. Raises HTTP 400 on failure."""
    try:
        assert_writing_prompt_allowed(text, user_id=user_id)
    except ValueError as e:
        raise _http_400(str(e)) from e


def validate_image_prompt(text: str) -> None:
    """Legacy validator — custom image prompt text is not used for generation."""
    try:
        s = (text or "").strip()
        _check_common_valueerror(s)
        for pat, msg in _IMAGE_OFFTOPIC_PATTERNS:
            if pat.search(s):
                raise ValueError(msg)
        if not _has_any(_IMAGE_TOPIC_PATTERNS, s):
            raise ValueError(
                "Image prompts must describe a visual / image to generate. "
                "Include words like 'image', 'photo', 'illustration', 'scene', 'composition', or 'style'."
            )
    except ValueError as e:
        raise _http_400(str(e)) from e
