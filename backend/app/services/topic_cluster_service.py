"""
TopicClusterService — Feature 2 (Topical Authority Cluster Mapping).

- ``analyze_serp`` — best-effort Google HTML SERP scrape (same stack as Research).
- ``derive_pillar_and_clusters`` — OpenAI JSON map (see :mod:`app.services.topic_cluster_llm`).
- ``plan_and_persist`` — analyze + derive + ``save_topic_cluster``.
- ``import_topics`` — create *pending* articles for selected topics (no body), with
  optional WordPress scheduling. Cheap and quota-free, so users can stage drafts
  without burning generation credits.
- ``generate_all`` — create pending articles + run :func:`app.services.article_pipeline.execute_article_generation`
  for pillar and each cluster row (skips rows that already have ``imported_article_id``).
  Accepts an explicit ``topic_ids`` subset and pre-checks article quota so the
  request never half-burns through the user's plan.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException

from app.core.article_duplicates import normalize_article_title_key, sync_project_title_index
from app.legacy.storage import get_legacy_storage_module
from app.services.article_pipeline import execute_article_generation
from app.services.research_scraper import extract_serp, fetch_google_serp_html
from app.services.topic_cluster_llm import derive_topical_cluster_map
from app.services.user_timezone import parse_schedule_input_to_utc, zoneinfo_for_user

log = logging.getLogger(__name__)


def _now_iso_seconds() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")


def _require_verified_website(project: dict[str, Any]) -> None:
    status = (project.get("wp_verified_status") or "").strip().lower()
    if status != "connected":
        raise HTTPException(
            status_code=400,
            detail={
                "code": "website_not_connected",
                "message": "Website is not connected for this project. Connect and verify WordPress in Project Settings to generate or schedule articles.",
            },
        )


def _unique_article_title(*, st: Any, project_id: str, desired: str) -> str:
    """Ensure ``desired`` does not collide with existing project titles (case-insensitive)."""
    base = (desired or "").strip()[:480] or "Article"
    idx = sync_project_title_index(st, project_id)
    candidate = base
    for n in range(0, 40):
        k = normalize_article_title_key(candidate)
        if k and k not in idx:
            return candidate[:500]
        suffix = f" ({n + 1})" if n else " (cluster)"
        candidate = (base[: 500 - len(suffix)] + suffix)[:500]
    return f"{base[:420]}_{uuid.uuid4().hex[:8]}"[:500]


def _insert_pending_article(
    *,
    st: Any,
    project_id: str,
    title: str,
    keywords: list[str],
    focus_keyphrase: str,
) -> str:
    aid = str(uuid.uuid4())
    now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    st.insert_article(
        {
            "id": aid,
            "project_id": project_id,
            "title": title[:500],
            "keywords": keywords[:10],
            "status": "pending",
            "article": "",
            "focus_keyphrase": (focus_keyphrase or "").strip()[:500],
            "meta_title": "",
            "meta_description": "",
            "generated_at": "",
            "posted_at": "",
            "created_at": now_str,
            "gsc_status": "pending",
        }
    )
    return aid


class TopicClusterService:
    """Project-scoped service. Instantiate per-request."""

    def __init__(self, *, project: dict[str, Any], owner_user_id: str) -> None:
        self.project = project
        self.owner_user_id = (owner_user_id or "").strip()
        self.project_id = (project.get("id") or "").strip()

    def persist(self, cluster: dict[str, Any]) -> dict[str, Any]:
        """Upsert a cluster row using the storage layer."""
        st = get_legacy_storage_module()
        payload = {
            **cluster,
            "id": (cluster.get("id") or "").strip() or f"tc_{uuid.uuid4().hex[:12]}",
            "project_id": self.project_id,
            "owner_user_id": self.owner_user_id,
            "created_at": cluster.get("created_at") or _now_iso_seconds(),
            "updated_at": _now_iso_seconds(),
        }
        return st.save_topic_cluster(payload)

    def list_for_project(self, *, limit: int = 100) -> list[dict[str, Any]]:
        st = get_legacy_storage_module()
        return st.list_topic_clusters_for_project(self.project_id, limit=limit)

    def get(self, cluster_id: str) -> dict[str, Any] | None:
        st = get_legacy_storage_module()
        row = st.get_topic_cluster_by_id(cluster_id)
        if not isinstance(row, dict):
            return None
        if (row.get("project_id") or "") != self.project_id:
            return None
        return row

    async def analyze_serp(
        self, *, seed_intent: str, country_code: str, language: str = "en"
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Returns ``(top_results, serp_summary_dict)`` for persistence."""
        gl = (country_code or "US").strip().upper()[:8] or "US"
        hl = (language or "en").strip().lower()[:8] or "en"
        q = " ".join((seed_intent or "").split())[:200]
        results: list[dict[str, Any]] = []
        fetched_at = 0.0
        try:
            html = await fetch_google_serp_html(query=q, gl=gl, hl=hl, timeout_s=14.0)
            ext = extract_serp(query=q, gl=gl, hl=hl, html=html)
            fetched_at = float(ext.fetched_at or 0.0)
            for r in (ext.results or [])[:10]:
                if not isinstance(r, dict):
                    continue
                results.append(
                    {
                        "title": (r.get("title") or "")[:200],
                        "url": (r.get("url") or "")[:2048],
                        "snippet": "",
                        "intent": "organic",
                    }
                )
        except Exception as e:
            log.warning("topic_cluster SERP fetch failed: %s", e)

        summary = {
            "query": q,
            "gl": gl,
            "hl": hl,
            "fetched_at": fetched_at,
            "result_count": len(results),
            "results": [{"title": x["title"], "url": x["url"], "snippet": x.get("snippet") or ""} for x in results],
        }
        return results, summary

    async def derive_pillar_and_clusters(
        self,
        *,
        seed_intent: str,
        country_code: str,
        tone: str = "informative",
        language: str = "en",
        serp_results: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Build one Pillar + 4-6 Cluster topics (not yet persisted)."""
        return await derive_topical_cluster_map(
            seed_intent=seed_intent,
            country_code=country_code,
            tone=tone,
            language=language,
            serp_results=serp_results,
        )

    async def plan_and_persist(
        self,
        *,
        seed_intent: str,
        country_code: str,
        tone: str,
        language: str,
    ) -> dict[str, Any]:
        """Full plan pipeline: SERP → LLM map → saved cluster row (status ``draft``)."""
        raw = (seed_intent or "").strip()
        if len(raw) < 3:
            raise HTTPException(status_code=400, detail="seed_intent must be at least 3 characters")
        serp_rows, serp_summary = await self.analyze_serp(seed_intent=raw, country_code=country_code, language=language)
        derived = await self.derive_pillar_and_clusters(
            seed_intent=raw,
            country_code=country_code,
            tone=tone,
            language=language,
            serp_results=serp_rows,
        )
        cluster_id = f"tc_{uuid.uuid4().hex[:14]}"
        doc: dict[str, Any] = {
            "id": cluster_id,
            "project_id": self.project_id,
            "owner_user_id": self.owner_user_id,
            "seed_intent": raw[:500],
            "country_code": (country_code or "IN").strip().upper()[:8],
            "tone": (tone or "informative").strip()[:32],
            "status": "draft",
            "pillar": derived["pillar"],
            "clusters": derived["clusters"],
            "serp_summary": serp_summary,
            "generation_errors": [],
        }
        return self.persist(doc)

    # ------------------------------------------------------------------
    # Selection helpers shared by ``import_topics`` and ``generate_all``.
    # ------------------------------------------------------------------

    @staticmethod
    def _pillar_slot_id(pillar: dict[str, Any]) -> str:
        return (pillar.get("id") or "pillar").strip() or "pillar"

    @staticmethod
    def _topic_focus(topic: dict[str, Any]) -> str:
        kws = topic.get("keywords")
        if isinstance(kws, list) and kws:
            first = str(kws[0]).strip()
            if first:
                return first
        return str(topic.get("title") or "").strip()

    def _select_pending(
        self,
        *,
        pillar: dict[str, Any],
        clusters: list[dict[str, Any]],
        topic_ids: list[str] | None,
    ) -> tuple[bool, list[dict[str, Any]]]:
        """
        Returns ``(include_pillar, [cluster_row, …])`` for everything still pending
        (no ``imported_article_id``) that the caller asked to act on. ``topic_ids``
        of ``None`` means "all unimported".
        """
        wanted: set[str] | None = None
        if topic_ids is not None:
            wanted = {str(t).strip() for t in topic_ids if str(t).strip()}

        pillar_id = self._pillar_slot_id(pillar)
        include_pillar = (
            (pillar.get("title") or "").strip()
            and not (pillar.get("imported_article_id") or "").strip()
            and (wanted is None or pillar_id in wanted)
        )

        out_clusters: list[dict[str, Any]] = []
        for c in clusters:
            if not isinstance(c, dict):
                continue
            cid = (c.get("id") or "").strip() or "cluster"
            if (c.get("imported_article_id") or "").strip():
                continue
            if not (c.get("title") or "").strip():
                continue
            if wanted is not None and cid not in wanted:
                continue
            out_clusters.append(c)
        return bool(include_pillar), out_clusters

    # ------------------------------------------------------------------
    # Import (no LLM): create pending articles and optionally schedule them.
    # ------------------------------------------------------------------

    async def import_topics(
        self,
        *,
        user: dict[str, Any],
        cluster_id: str,
        topic_ids: list[str] | None,
        schedule_at: str | None = None,
        post_type: str | None = None,
        wp_status: str = "draft",
        writing_prompt_id: str | None = None,
        image_prompt_id: str | None = None,
        generate_image: bool = True,
    ) -> dict[str, Any]:
        """
        Create pending article rows for the selected (or all-pending) topics.

        Two flavours:

        - ``schedule_at`` is None: just inserts the ``article`` rows (no body).
          The user can then go to the Articles tab to edit / generate manually.
          No quota is consumed because nothing is generated.
        - ``schedule_at`` is set: also creates a scheduled-job row so the
          backend's scheduler will generate + publish the article at that UTC
          instant. Schedule quota is consumed per topic via
          ``consume_scheduled_usage`` if available.

        Both flows persist ``imported_article_id`` onto the topic so the UI can
        show "Imported" badges immediately.
        """
        st = get_legacy_storage_module()
        row = self.get(cluster_id)
        if not row:
            raise HTTPException(status_code=404, detail="Topic cluster not found")

        proj = self.project
        pid = self.project_id
        uid = (user.get("id") or "").strip()
        role = (user.get("role") or "").strip().lower()

        pillar = dict(row.get("pillar") or {})
        clusters = [dict(c) for c in (row.get("clusters") or []) if isinstance(c, dict)]
        include_pillar, selected_clusters = self._select_pending(
            pillar=pillar, clusters=clusters, topic_ids=topic_ids,
        )
        total = (1 if include_pillar else 0) + len(selected_clusters)
        if total == 0:
            raise HTTPException(
                status_code=400,
                detail="Nothing to import — every selected topic is already imported.",
            )

        # Validate / parse schedule input once. For batch imports we stagger each
        # subsequent topic by 5 minutes so they don't pile onto the scheduler at
        # the same minute (post_type rate limits, WP indexing pings, etc.).
        scheduled_dt_utc: datetime | None = None
        if schedule_at and schedule_at.strip():
            _require_verified_website(proj)
            try:
                user_tz = zoneinfo_for_user(user.get("timezone"))
                scheduled_dt_utc = parse_schedule_input_to_utc(schedule_at.strip(), user_tz=user_tz)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e) or "Invalid schedule time format") from None
            except Exception:
                raise HTTPException(status_code=400, detail="Invalid schedule time format") from None
            if scheduled_dt_utc < (datetime.now(timezone.utc) + timedelta(minutes=10)):
                raise HTTPException(
                    status_code=400,
                    detail="Scheduled time must be at least 10 minutes from now.",
                )
            # Pre-check schedule quota for the whole batch.
            if role != "admin" and uid and hasattr(st, "consume_scheduled_usage"):
                plan_key = ((user.get("subscription_type") or "").strip().lower() or "beta")
                plan: dict = {}
                try:
                    plans = st.load_plans() or {}
                    plan = plans.get(plan_key) if isinstance(plans, dict) else {}
                    if not isinstance(plan, dict):
                        plan = {}
                except Exception:
                    plan = {}
                if plan.get("allow_scheduling") is False:
                    raise HTTPException(status_code=403, detail="Scheduling is not enabled for your plan.")
                ok, msg = st.consume_scheduled_usage(
                    uid,
                    month_limit=plan.get("max_scheduled_per_month"),
                    amount=total,
                )
                if not ok:
                    raise HTTPException(status_code=403, detail=msg or "Schedule limit reached for your plan.")

        wp_status_norm = (wp_status or "draft").strip().lower()
        if wp_status_norm not in {"draft", "publish"}:
            raise HTTPException(status_code=400, detail="Invalid wp_status (draft|publish)")
        post_type_norm = (post_type or "").strip() or (proj.get("default_wp_rest_base") or "").strip() or "posts"

        errors: list[dict[str, str]] = list(row.get("generation_errors") or [])
        imported_count = 0
        scheduled_count = 0

        async def _import_one(*, topic_id: str, title: str, keywords: list[str], focus: str, slot_offset: int) -> str | None:
            """Insert pending article and (if applicable) schedule it. Returns article id."""
            nonlocal imported_count, scheduled_count
            try:
                t_title = await asyncio.to_thread(_unique_article_title, st=st, project_id=pid, desired=title)
                kws = [str(k).strip()[:80] for k in (keywords or []) if str(k).strip()][:10]
                fk = (focus or t_title).strip()[:500]
                aid = await asyncio.to_thread(
                    _insert_pending_article,
                    st=st,
                    project_id=pid,
                    title=t_title,
                    keywords=kws,
                    focus_keyphrase=fk,
                )
                imported_count += 1

                if scheduled_dt_utc is not None and hasattr(st, "insert_scheduled_job"):
                    # Stagger subsequent imports 5 minutes apart so the scheduler
                    # doesn't queue them all on the same minute boundary.
                    run_at = scheduled_dt_utc + timedelta(minutes=5 * slot_offset)
                    norm_utc = run_at.replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S")
                    cat_raw = (proj.get("wp_category_ids") or "").strip()
                    stable = hashlib.sha1(f"{pid}:{aid}".encode("utf-8")).hexdigest()[:20]
                    job_id = f"job_{stable}"
                    now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
                    job_updates = {
                        "project_id": pid,
                        "article_id": aid,
                        "run_at": norm_utc,
                        "post_type": post_type_norm,
                        "wp_status": wp_status_norm,
                        "category_ids": cat_raw,
                        "writing_prompt_id": (writing_prompt_id or "").strip(),
                        "image_prompt_id": (image_prompt_id or "").strip(),
                        "generate_image": bool(generate_image),
                        "state": "scheduled",
                        "attempts": 0,
                        "last_attempt_at": "",
                        "last_error": "",
                        "updated_at": now_str,
                    }
                    try:
                        await asyncio.to_thread(st.insert_scheduled_job, {"id": job_id, **job_updates, "created_at": now_str})
                    except Exception:
                        # Same race-resilience as articles.schedule_article: fall back to update.
                        try:
                            await asyncio.to_thread(st.update_scheduled_job_fields, job_id, job_updates)
                        except Exception:
                            errors.append({"topic_id": topic_id, "message": "Article imported but failed to schedule."})
                            return aid
                    # Reflect on the article row so the Articles list shows the marker.
                    await asyncio.to_thread(
                        st.update_article_fields,
                        aid,
                        {
                            "wp_scheduled_at": norm_utc,
                            "wp_schedule_wp_status": wp_status_norm,
                            "wp_rest_base": post_type_norm,
                            "wp_schedule_error": "",
                        },
                    )
                    scheduled_count += 1
                return aid
            except HTTPException as he:
                errors.append({"topic_id": topic_id, "message": (str(he.detail) if he.detail else str(he))[:500]})
                return None
            except Exception as e:
                errors.append({"topic_id": topic_id, "message": str(e)[:500]})
                log.exception("cluster import failed for %s", topic_id)
                return None

        slot = 0
        if include_pillar:
            aid = await _import_one(
                topic_id=self._pillar_slot_id(pillar),
                title=str(pillar.get("title") or ""),
                keywords=list(pillar.get("keywords") or []),
                focus=self._topic_focus(pillar),
                slot_offset=slot,
            )
            slot += 1
            if aid:
                pillar["imported_article_id"] = aid

        for c in selected_clusters:
            cid = (c.get("id") or "").strip() or "cluster"
            aid = await _import_one(
                topic_id=cid,
                title=str(c.get("title") or ""),
                keywords=list(c.get("keywords") or []),
                focus=self._topic_focus(c),
                slot_offset=slot,
            )
            slot += 1
            if aid:
                # Mutate the original cluster row from ``row``'s list so persistence picks it up.
                for orig in clusters:
                    if (orig.get("id") or "").strip() == cid:
                        orig["imported_article_id"] = aid
                        break

        row["pillar"] = pillar
        row["clusters"] = clusters
        row["generation_errors"] = errors
        row["status"] = (
            "ready"
            if not errors and self._all_topics_imported(pillar, clusters)
            else ("partial_error" if errors else (row.get("status") or "draft"))
        )
        row["updated_at"] = _now_iso_seconds()
        saved = await asyncio.to_thread(st.save_topic_cluster, row)
        return {
            "ok": True,
            "cluster": saved,
            "errors": errors,
            "imported_count": imported_count,
            "scheduled_count": scheduled_count,
        }

    @staticmethod
    def _all_topics_imported(pillar: dict[str, Any], clusters: list[dict[str, Any]]) -> bool:
        if not (pillar.get("imported_article_id") or "").strip():
            return False
        for c in clusters:
            if not (c.get("imported_article_id") or "").strip():
                return False
        return True

    async def generate_all(
        self,
        *,
        user: dict[str, Any],
        cluster_id: str,
        generate_image: bool,
        writing_prompt_id: str | None,
        image_prompt_id: str | None,
        topic_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        """
        Generate article bodies for the pillar + each cluster without ``imported_article_id``.

        ``topic_ids=None`` means "every pending topic in this cluster". When
        the caller passes a list, only those slot ids are generated. The pillar
        slot id is the pillar's own ``id`` (or the literal string ``pillar`` if
        the LLM didn't supply one).

        Persists ``imported_article_id`` on success and appends to
        ``generation_errors`` on failure. Pre-checks the user's article quota
        so we never half-burn through the plan when the request was doomed.
        """
        st = get_legacy_storage_module()
        row = self.get(cluster_id)
        if not row:
            raise HTTPException(status_code=404, detail="Topic cluster not found")

        proj = self.project
        pid = self.project_id
        _require_verified_website(proj)
        uid = (user.get("id") or "").strip()
        role = (user.get("role") or "").strip().lower()
        errors: list[dict[str, str]] = []

        pillar = dict(row.get("pillar") or {})
        clusters = [dict(c) for c in (row.get("clusters") or []) if isinstance(c, dict)]
        include_pillar, selected_clusters = self._select_pending(
            pillar=pillar, clusters=clusters, topic_ids=topic_ids,
        )
        needed = (1 if include_pillar else 0) + len(selected_clusters)
        if needed == 0:
            raise HTTPException(
                status_code=400,
                detail="Nothing to generate — every selected topic is already generated.",
            )

        # Pre-flight quota check — fail fast with a structured payload the UI
        # can render in a "limit reached" modal instead of swallowing it.
        if role != "admin" and uid and hasattr(st, "peek_article_usage_remaining"):
            plan_key = ((user.get("subscription_type") or "").strip().lower() or "beta")
            plan: dict = {}
            try:
                plans = st.load_plans() or {}
                plan = plans.get(plan_key) if isinstance(plans, dict) else {}
                if not isinstance(plan, dict):
                    plan = {}
            except Exception:
                plan = {}
            snap = st.peek_article_usage_remaining(
                uid,
                day_limit=plan.get("max_articles_per_day"),
                month_limit=plan.get("max_articles_per_month"),
            )
            allowed = snap.get("max_can_consume_now")
            if allowed is not None and allowed < needed:
                raise HTTPException(
                    status_code=403,
                    detail={
                        "code": "quota_exceeded",
                        "message": (
                            f"Your plan only has {allowed} article generation{'s' if allowed != 1 else ''} "
                            f"remaining today/this month. You're trying to generate {needed}."
                        ),
                        "needed": needed,
                        "allowed": allowed,
                        "plan_key": plan_key,
                        **{k: v for k, v in snap.items() if k not in {"day_key", "month_key"}},
                    },
                )

        row["status"] = "generating"
        row["generation_errors"] = []
        await asyncio.to_thread(lambda: st.save_topic_cluster(dict(row)))

        async def _one_slot(*, topic_id: str, title: str, keywords: list[str], focus: str) -> str | None:
            if not (title or "").strip():
                return None
            t_title = await asyncio.to_thread(_unique_article_title, st=st, project_id=pid, desired=title)
            kws = [str(k).strip()[:80] for k in (keywords or []) if str(k).strip()][:10]
            fk = (focus or t_title).strip()[:500]
            try:
                aid = await asyncio.to_thread(
                    _insert_pending_article,
                    st=st,
                    project_id=pid,
                    title=t_title,
                    keywords=kws,
                    focus_keyphrase=fk,
                )
                fresh = await asyncio.to_thread(lambda: st.get_article(project_id=pid, article_id=aid))
                if not isinstance(fresh, dict):
                    raise RuntimeError("inserted article not readable")
                await execute_article_generation(
                    st=st,
                    user=user,
                    proj=proj,
                    project_id=pid,
                    article_id=aid,
                    row=fresh,
                    writing_prompt_id=writing_prompt_id,
                    image_prompt_id=image_prompt_id,
                    generate_image=generate_image,
                    focus_keyphrase_override=None,
                )
                return aid
            except HTTPException as he:
                errors.append({"topic_id": topic_id, "message": (str(he.detail) if he.detail else str(he))[:500]})
                return None
            except Exception as e:
                errors.append({"topic_id": topic_id, "message": str(e)[:500]})
                log.exception("cluster generate failed for %s", topic_id)
                return None

        if include_pillar:
            aid = await _one_slot(
                topic_id=self._pillar_slot_id(pillar),
                title=str(pillar.get("title") or ""),
                keywords=list(pillar.get("keywords") or []),
                focus=self._topic_focus(pillar),
            )
            if aid:
                pillar["imported_article_id"] = aid

        for c in selected_clusters:
            cid = (c.get("id") or "").strip() or "cluster"
            aid = await _one_slot(
                topic_id=cid,
                title=str(c.get("title") or ""),
                keywords=list(c.get("keywords") or []),
                focus=self._topic_focus(c),
            )
            if aid:
                # Mutate the original cluster row from ``row``'s list so persistence picks it up.
                for orig in clusters:
                    if (orig.get("id") or "").strip() == cid:
                        orig["imported_article_id"] = aid
                        break

        row["pillar"] = pillar
        row["clusters"] = clusters
        row["generation_errors"] = errors
        # ``ready`` only when *every* topic in the cluster is imported. A partial
        # generation (e.g. user selected a subset, or some failed) leaves the
        # cluster in either ``partial_error`` (if anything errored) or back to
        # ``draft`` so the UI keeps offering "Generate selected" for the rest.
        if errors:
            row["status"] = "partial_error"
        elif self._all_topics_imported(pillar, clusters):
            row["status"] = "ready"
        else:
            row["status"] = "draft"
        row["updated_at"] = _now_iso_seconds()
        saved = await asyncio.to_thread(st.save_topic_cluster, row)
        return {
            "ok": True,
            "cluster": saved,
            "errors": errors,
        }
