"""
ClusterValidationService — Existence & Intent Validation engine for Cluster UI.

Goal: tell the Cluster Planner UI whether each proposed topic is genuinely
**new**, **similar** to something already in the project / on the live site, or
a flat-out **duplicate**, *before* the user spends a generation credit.

Pipeline (per request):

1. **Parallel cache reads** — load the project's existing article titles and
   the cached WordPress site map in parallel (``asyncio.gather`` + ``to_thread``).
2. **Exact-match scan** — case-insensitive, NFKC-folded title comparison against
   both corpora. Hits short-circuit out (we never burn an embedding call on
   topics we already know are duplicates).
3. **Intent overlap (embeddings)** — for everything still pending we batch a
   single OpenAI embedding call combining {queries + corpus}, score cosine
   similarity, and bucket each query at the configured threshold (default 0.80).
4. **Async cache refresh** — if the site map is older than 24h *and* the project
   has WP credentials, schedule :class:`InternalLinkService.sync_site_map_from_wp`
   via ``asyncio.create_task`` so future requests are warm. Never blocks the
   current response.

Every method is awaitable; nothing mutates shared state outside the storage
layer (which has its own ``_db_write_lock``), so this is safe to run under
multiple uvicorn workers.

Latency budget: under 500ms for batches up to 12 topics on warm caches. Embedding
call is the long pole (~120-200ms); exact matches add <5ms.
"""

from __future__ import annotations

import asyncio
import logging
import math
from typing import Any, Literal, TypedDict

from app.core.article_duplicates import normalize_article_title_key, sync_project_title_index
from app.core.config import settings
from app.legacy.storage import get_legacy_storage_module
from app.services.openai_client import OpenAIClient


log = logging.getLogger(__name__)


# Anything older than this triggers a *non-blocking* WP cache refresh.
_SITE_MAP_TTL_SECONDS = 24 * 60 * 60

# Hard upper bound on how many corpus rows we fold into the embedding call to
# keep the request well within OpenAI's 2048-input cap and our latency budget.
_EMBEDDING_CORPUS_CAP = 250

# Minimum length for a topic title to be eligible for embedding comparison.
# Short strings (< 4 chars) produce noisy embeddings; we only do the exact
# match for those, which is more correct anyway.
_MIN_EMBED_LEN = 4


ValidationStatus = Literal["new", "similar", "duplicate"]


class ValidationItem(TypedDict, total=False):
    """One topic the UI wants validated. ``temp_id`` keys the response map."""

    temp_id: str
    title: str
    focus_keyphrase: str
    keywords: list[str]


class ValidationOutcome(TypedDict, total=False):
    status: ValidationStatus
    reason: str
    existing_url: str | None
    existing_article_id: str | None
    similarity: float | None


class ClusterValidationResponse(TypedDict, total=False):
    results: dict[str, ValidationOutcome]
    cache_age_seconds: int | None
    cache_refresh_started: bool
    embedding_used: bool
    elapsed_ms: int


# ---------------------------------------------------------------------------
# Pure helpers (unit-testable without a Mongo / OpenAI dependency)
# ---------------------------------------------------------------------------


def _build_query_text(item: ValidationItem) -> str:
    """Combine title + focus_keyphrase + first keywords into one string for embedding.

    Mirrors the corpus shape so cosine scores are comparable.
    """
    title = (item.get("title") or "").strip()
    focus = (item.get("focus_keyphrase") or "").strip()
    kws = item.get("keywords") or []
    parts: list[str] = [title]
    if focus and focus.lower() != title.lower():
        parts.append(focus)
    if isinstance(kws, list):
        clean_kws = [str(k).strip() for k in kws if str(k).strip()][:5]
        if clean_kws:
            parts.append(", ".join(clean_kws))
    return " — ".join(p for p in parts if p)[:400]


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0.0 or nb <= 0.0:
        return 0.0
    denom = math.sqrt(na) * math.sqrt(nb)
    if denom <= 0.0:
        return 0.0
    return dot / denom


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class ClusterValidationService:
    """Project-scoped service. Instantiate per request."""

    def __init__(self, *, project: dict[str, Any]) -> None:
        self.project = project
        self.project_id = (project.get("id") or "").strip()

    # -- corpus loaders ----------------------------------------------------

    async def _load_articles_index(self) -> dict[str, tuple[str, str]]:
        """``{normalized_key: (display_title, article_id)}`` for the project."""
        st = get_legacy_storage_module()
        return await asyncio.to_thread(sync_project_title_index, st, self.project_id)

    async def _load_site_map(self) -> list[dict[str, Any]]:
        st = get_legacy_storage_module()
        return await asyncio.to_thread(st.load_site_map_for_project, self.project_id, limit=5000)

    async def _site_map_age_seconds(self) -> int | None:
        st = get_legacy_storage_module()
        return await asyncio.to_thread(st.site_map_cache_age_seconds, self.project_id)

    # -- background refresh ------------------------------------------------

    def _maybe_schedule_wp_refresh(self, *, age: int | None) -> bool:
        """Fire-and-forget WP REST refresh if cache is stale and credentials exist.

        Returns ``True`` if a task was actually scheduled. Never blocks the
        current request — the present validation call still uses whatever
        cached rows we have right now.
        """
        if age is not None and age < _SITE_MAP_TTL_SECONDS:
            return False
        proj = self.project
        site = (proj.get("wp_site_url") or proj.get("website_url") or "").strip()
        user = (proj.get("wp_username") or "").strip()
        pw = (proj.get("wp_app_password") or "").strip()
        if not (site and user and pw):
            return False

        # Local import keeps the validation service standalone-importable
        # for tests that don't bring in the WordPress client transitively.
        from app.services.internal_link_service import InternalLinkService

        async def _runner() -> None:
            try:
                svc = InternalLinkService(project=proj)
                await svc.sync_site_map_from_wp()
            except Exception as e:  # pragma: no cover — best-effort
                log.warning("cluster-validation WP refresh failed for project %s: %s", self.project_id, e)

        try:
            asyncio.create_task(_runner())
            return True
        except RuntimeError:
            # No running loop (extremely rare under FastAPI). Skip silently.
            return False

    # -- main entry --------------------------------------------------------

    async def validate(
        self,
        *,
        items: list[ValidationItem],
        similarity_threshold: float = 0.80,
    ) -> ClusterValidationResponse:
        """Score each item and return ``{temp_id: ValidationOutcome}``."""
        results: dict[str, ValidationOutcome] = {}

        # Filter / dedupe input — keep the original temp_id ordering.
        clean: list[ValidationItem] = []
        seen: set[str] = set()
        for raw in items or []:
            tid = str((raw or {}).get("temp_id") or "").strip()
            title = str((raw or {}).get("title") or "").strip()
            if not tid or tid in seen:
                continue
            seen.add(tid)
            clean.append({
                "temp_id": tid,
                "title": title,
                "focus_keyphrase": str(raw.get("focus_keyphrase") or "").strip()[:200],
                "keywords": [str(k).strip()[:80] for k in (raw.get("keywords") or []) if str(k).strip()][:8],
            })

        if not clean:
            return {
                "results": {},
                "cache_age_seconds": None,
                "cache_refresh_started": False,
                "embedding_used": False,
                "elapsed_ms": 0,
            }

        # Load both corpora and the cache age in parallel.
        articles_index, site_map_rows, age = await asyncio.gather(
            self._load_articles_index(),
            self._load_site_map(),
            self._site_map_age_seconds(),
        )

        # Background WP refresh if stale; don't await.
        refresh_started = self._maybe_schedule_wp_refresh(age=age)

        # Build a normalized site-map index keyed by post title.
        site_map_by_key: dict[str, dict[str, Any]] = {}
        for row in site_map_rows or []:
            key = normalize_article_title_key(row.get("post_title") or "")
            if key and key not in site_map_by_key:
                site_map_by_key[key] = row

        # ---- Pass 1: exact (NFKC casefold) matches --------------------------
        pending: list[ValidationItem] = []
        for it in clean:
            tid = it["temp_id"]
            title = it.get("title") or ""
            key = normalize_article_title_key(title)
            if not title or not key:
                results[tid] = {
                    "status": "new",
                    "reason": "Empty or unparseable title — treated as new.",
                    "existing_url": None,
                    "existing_article_id": None,
                    "similarity": None,
                }
                continue
            # Live site beats project DB — a duplicate that's already published
            # is the most important warning to surface.
            sm = site_map_by_key.get(key)
            if sm:
                results[tid] = {
                    "status": "duplicate",
                    "reason": "Already published on your live WordPress site.",
                    "existing_url": (sm.get("post_url") or "").strip() or None,
                    "existing_article_id": None,
                    "similarity": 1.0,
                }
                continue
            hit = articles_index.get(key)
            if hit:
                stored_title, aid = hit
                results[tid] = {
                    "status": "duplicate",
                    "reason": f"Already exists in this project as “{stored_title}”.",
                    "existing_url": None,
                    "existing_article_id": aid or None,
                    "similarity": 1.0,
                }
                continue
            pending.append(it)

        # ---- Pass 2: embedding-based intent overlap -------------------------
        embedding_used = False
        if pending and (settings.openai_api_key or "").strip():
            corpus_strings, corpus_meta = self._build_corpus(
                articles_index=articles_index,
                site_map_rows=site_map_rows or [],
                cap=_EMBEDDING_CORPUS_CAP,
            )

            queries: list[tuple[ValidationItem, str]] = []
            for it in pending:
                qtext = _build_query_text(it)
                if len(qtext) < _MIN_EMBED_LEN:
                    results[it["temp_id"]] = {
                        "status": "new",
                        "reason": "Title too short for similarity comparison.",
                        "existing_url": None,
                        "existing_article_id": None,
                        "similarity": None,
                    }
                    continue
                queries.append((it, qtext))

            if queries and corpus_strings:
                texts = [q for _, q in queries] + corpus_strings
                try:
                    client = OpenAIClient()
                    vectors = await client.embed_batch(
                        model=settings.openai_embedding_model,
                        inputs=texts,
                    )
                except Exception as e:
                    log.warning("cluster-validation embedding init failed: %s", e)
                    vectors = []

                if len(vectors) == len(texts):
                    embedding_used = True
                    q_vecs = vectors[: len(queries)]
                    c_vecs = vectors[len(queries) :]
                    threshold = max(0.5, min(float(similarity_threshold or 0.80), 0.99))
                    for (it, _), q_vec in zip(queries, q_vecs):
                        best = (-1.0, -1)  # (score, corpus index)
                        for idx, c_vec in enumerate(c_vecs):
                            score = _cosine(q_vec, c_vec)
                            if score > best[0]:
                                best = (score, idx)
                        score, idx = best
                        if idx < 0 or score < threshold:
                            results[it["temp_id"]] = {
                                "status": "new",
                                "reason": "No semantically similar content found.",
                                "existing_url": None,
                                "existing_article_id": None,
                                "similarity": round(score, 3) if score > 0 else None,
                            }
                            continue
                        meta = corpus_meta[idx]
                        results[it["temp_id"]] = {
                            "status": "similar",
                            "reason": (
                                f"Intent overlap with existing “{meta['label']}” "
                                f"(cos {score:.2f})."
                            ),
                            "existing_url": meta.get("url"),
                            "existing_article_id": meta.get("article_id"),
                            "similarity": round(score, 3),
                        }
                else:
                    # Embedding API hiccup — fall through, mark all pending as new.
                    for it, _ in queries:
                        results[it["temp_id"]] = {
                            "status": "new",
                            "reason": "Similarity check unavailable — exact match cleared.",
                            "existing_url": None,
                            "existing_article_id": None,
                            "similarity": None,
                        }
            else:
                for it in pending:
                    if it["temp_id"] in results:
                        continue
                    results[it["temp_id"]] = {
                        "status": "new",
                        "reason": "No prior content to compare against.",
                        "existing_url": None,
                        "existing_article_id": None,
                        "similarity": None,
                    }
        else:
            # Either nothing to score, or no API key configured.
            for it in pending:
                results[it["temp_id"]] = {
                    "status": "new",
                    "reason": "Exact match cleared (similarity check disabled).",
                    "existing_url": None,
                    "existing_article_id": None,
                    "similarity": None,
                }

        return {
            "results": results,
            "cache_age_seconds": age,
            "cache_refresh_started": refresh_started,
            "embedding_used": embedding_used,
        }

    # -- corpus assembly ---------------------------------------------------

    @staticmethod
    def _build_corpus(
        *,
        articles_index: dict[str, tuple[str, str]],
        site_map_rows: list[dict[str, Any]],
        cap: int,
    ) -> tuple[list[str], list[dict[str, Any]]]:
        """Flatten site_map + project articles into ordered (texts, metas) pair.

        ``metas[i]`` describes ``texts[i]`` so we can attribute back which row
        triggered the highest cosine score.
        """
        texts: list[str] = []
        metas: list[dict[str, Any]] = []

        # Live site rows first — duplicates here are the most important to flag.
        for row in site_map_rows[: cap // 2]:
            title = (row.get("post_title") or "").strip()
            if not title:
                continue
            focus = (row.get("focus_keyphrase") or "").strip()
            label = title[:180]
            text = f"{title} — {focus}" if focus else title
            texts.append(text[:400])
            metas.append({
                "label": label,
                "url": (row.get("post_url") or "").strip() or None,
                "article_id": None,
            })

        # Then existing project articles (titles only — no focus keyphrase
        # available without an extra read; titles alone score reliably here).
        remaining = max(0, cap - len(texts))
        for key, (title, aid) in list(articles_index.items())[:remaining]:
            display = (title or "").strip()
            if not display:
                continue
            texts.append(display[:400])
            metas.append({
                "label": display[:180],
                "url": None,
                "article_id": (aid or "").strip() or None,
            })

        return texts, metas
