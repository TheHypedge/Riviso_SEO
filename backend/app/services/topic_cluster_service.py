"""
TopicClusterService — Feature 2 (Topical Authority Cluster Mapping).

This v1 ships the **service skeleton** + storage glue that the next iteration will
fill in. The class shape is final so downstream callers (routes, scheduler hooks,
admin reports) can import it confidently today and the implementation can land
without touching call sites.

Planned business logic for the next session:

1. ``analyze_serp(seed_intent, country)`` — fetch top-10 SERP results (via the
   research module's existing OpenAI-backed simulator first; pluggable upgrade
   path for a real SERP API later).
2. ``derive_pillar_and_clusters(serp_results)`` — LLM-prompted decomposition into
   one Pillar theme + 4-6 Cluster sub-topics with intent and keyword hints.
3. ``persist(cluster, owner_user_id)`` — uses :func:`storage.save_topic_cluster`.
4. ``generate_all(cluster_id)`` — fan-out to the existing article generation pipe
   for the pillar and each cluster, writing back ``imported_article_id`` per row.

For v1 only :meth:`persist`, :meth:`get`, and :meth:`list_for_project` are wired —
those are non-AI bookkeeping operations and therefore safe to ship now. The two
methods that need product/SEO sign-off raise ``NotImplementedError`` with a
descriptive message so callers fail loudly during rollout instead of silently.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any

from app.legacy.storage import get_legacy_storage_module


log = logging.getLogger(__name__)


def _now_iso_seconds() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")


class TopicClusterService:
    """Project-scoped service. Instantiate per-request."""

    def __init__(self, *, project: dict[str, Any], owner_user_id: str) -> None:
        self.project = project
        self.owner_user_id = (owner_user_id or "").strip()
        self.project_id = (project.get("id") or "").strip()

    # ----- bookkeeping (working in v1) ----------------------------------------

    def persist(self, cluster: dict[str, Any]) -> dict[str, Any]:
        """Upsert a cluster row using the storage layer."""
        st = get_legacy_storage_module()
        payload = {
            **cluster,
            "id": (cluster.get("id") or "").strip() or f"tc_{uuid.uuid4().hex[:12]}",
            "project_id": self.project_id,
            "owner_user_id": self.owner_user_id,
            "created_at": cluster.get("created_at") or _now_iso_seconds(),
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
        # Guard against cross-project access (route-level access check is the primary defense).
        if (row.get("project_id") or "") != self.project_id:
            return None
        return row

    # ----- intelligence (skeleton — implementation lands next session) --------

    async def analyze_serp(self, *, seed_intent: str, country_code: str) -> list[dict[str, Any]]:
        """
        Returns a list of top-10 SERP results [{title, url, snippet, intent}, ...].

        Future: drive via existing research module helpers (``research_ideas`` style),
        upgrading to a real SERP API once an env-driven adapter lands. Today: stub.
        """
        raise NotImplementedError(
            "TopicClusterService.analyze_serp is scheduled for the next iteration. "
            "Schema and persistence are in place; SERP analyzer + LLM decomposition "
            "land in the follow-up PR."
        )

    async def derive_pillar_and_clusters(
        self, *, seed_intent: str, country_code: str, tone: str = "informative"
    ) -> dict[str, Any]:
        """Build one Pillar + 4-6 Cluster topics. Returns the un-persisted draft."""
        raise NotImplementedError(
            "TopicClusterService.derive_pillar_and_clusters is scheduled for the next iteration."
        )

    async def generate_all(self, *, cluster_id: str) -> dict[str, Any]:
        """
        Fan-out: enqueue article generation for the pillar and every cluster row, writing
        back ``imported_article_id`` on each so the UI can deep-link to the draft articles.
        """
        raise NotImplementedError(
            "TopicClusterService.generate_all is scheduled for the next iteration."
        )
