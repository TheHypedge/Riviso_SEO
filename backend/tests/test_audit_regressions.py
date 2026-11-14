"""Regressions from the 2026-11-14 end-to-end audit. Fake collections only, never a real DB."""

import os
import sys

os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

import storage  # noqa: E402


class _Articles:
    def __init__(self, doc):
        self.doc, self.replaced = doc, None

    def find_one(self, q):
        return dict(self.doc) if q.get("id") == self.doc["id"] else None

    def replace_one(self, q, new_doc):
        self.replaced = new_doc
        return type("R", (), {"acknowledged": True, "matched_count": 1})()


def test_full_update_keeps_fields_outside_the_read_shape(monkeypatch):
    doc = {
        "_id": "a1", "id": "a1", "project_id": "p", "title": "T", "sync_status": "drifted",
        "topic_cluster_id": "c9", "featured_image_regeneration_count": 3,
        "shopify_scheduled_at": "2026-12-01", "source_url": "https://x.com",
    }
    col = _Articles(doc)
    monkeypatch.setattr(storage, "_storage_mode", "mongo")
    monkeypatch.setattr(storage, "get_db", lambda: type("DB", (), {"articles": col})())
    assert storage.update_article_fields("a1", {"status": "published"})
    out = col.replaced
    assert out["status"] == "published"
    for k in ("sync_status", "topic_cluster_id", "featured_image_regeneration_count", "shopify_scheduled_at", "source_url"):
        assert out[k] == doc[k], k


def test_shopify_catalog_fallback_resolves_images(monkeypatch):
    from app.services import shopify_product_pipeline as spp

    rows = [{"name": "Red Kurta", "url": "https://s.com/products/red-kurta"}]
    monkeypatch.setattr(spp, "select_relevant_shopify_products", lambda **_: rows)
    monkeypatch.setattr(
        spp, "_load_shopify_catalog_products",
        lambda _p: [{"handle": "red-kurta", "image_url": "https://cdn.shopify.com/a.jpg"}],
    )
    out = spp._catalog_fallback_products(proj={"id": "p"}, title="t", keywords=[], focus_keyphrase="k", max_products=3)
    assert [p.handle for p in out] == ["red-kurta"]


def test_project_delete_cascades_to_every_project_scoped_collection(monkeypatch):
    deleted: dict[str, list] = {}

    class Col:
        def __init__(self, name):
            self.name = name

        def count_documents(self, *_a, **_k):
            return 1

        def find(self, q, *_a):
            return [{"_id": "aud1"}] if self.name == "seo_audits" else []

        def delete_many(self, q):
            deleted.setdefault(self.name, []).append(q)

        delete_one = delete_many

    class DB:
        def __getattr__(self, name):
            return Col(name)

        __getitem__ = __getattr__

    monkeypatch.setattr(storage, "_storage_mode", "mongo")
    monkeypatch.setattr(storage, "get_db", lambda: DB())
    monkeypatch.setattr(storage, "_cleanup_article_media", lambda _rows: None)
    assert storage.delete_project_and_resources("p1")
    for col in ("articles", "scheduled_jobs", "projects", *storage._PROJECT_SCOPED_COLLECTIONS):
        assert col in deleted, col
    assert deleted["seo_audit_links"] == [{"audit_id": {"$in": ["aud1"]}}]


def test_cloudinary_url_is_not_reuploaded_on_save(monkeypatch):
    import app.services.cloudinary_storage as cs

    monkeypatch.setattr(cs, "upload_image_bytes", lambda *a, **k: (_ for _ in ()).throw(AssertionError("re-upload")))
    url = "https://res.cloudinary.com/demo/image/upload/v1/riviso/articles/a1/featured.png"
    out = storage._externalize_featured_image_in_updates("a1", {"image_url": url})
    assert out == {"image_url": url, "featured_image_storage": "cloudinary"}


class _FakeCursor(list):
    def sort(self, key, direction=1):
        keys = key if isinstance(key, list) else [(key, direction)]
        return _FakeCursor(sorted(self, key=lambda d: tuple(d.get(k) if d.get(k) is not None else 0 for k, _ in keys)))

    def batch_size(self, _n):
        return self

    def skip(self, n):
        return _FakeCursor(self[n:])

    def limit(self, n):
        return _FakeCursor(self[:n])


class _FakeCol:
    def __init__(self):
        self.rows: list[dict] = []

    @staticmethod
    def _match(d, q):
        for k, v in (q or {}).items():
            if isinstance(v, dict) and "$in" in v:
                if d.get(k) not in v["$in"]:
                    return False
            elif d.get(k) != v:
                return False
        return True

    def find(self, q=None, proj=None):
        out = []
        for d in self.rows:
            if self._match(d, q):
                d2 = dict(d)
                if proj and proj.get("_id") == 0:
                    d2.pop("_id", None)
                out.append(d2)
        return _FakeCursor(out)

    def find_one(self, q=None, proj=None):
        r = self.find(q, proj)
        return r[0] if r else None

    def count_documents(self, q=None, **_k):
        return len(self.find(q))

    def insert_many(self, docs, ordered=True):
        self.rows.extend(dict(d) for d in docs)

    def delete_many(self, q):
        self.rows = [d for d in self.rows if not self._match(d, q)]

    def update_one(self, q, upd):
        for d in self.rows:
            if self._match(d, q):
                d.update(upd.get("$set", {}))

    def aggregate(self, pipeline):
        match = pipeline[0]["$match"]
        groups: dict = {}
        for d in self.find(match):
            key = d.get(pipeline[1]["$group"]["_id"].lstrip("$"))
            g = groups.setdefault(key, {"_id": key, "n": 0, "affected_urls": 0, **{f: d.get(f) for f in ("category", "severity", "priority", "effort")}})
            g["n"] += 1
            g["affected_urls"] += 1
        if len(pipeline) > 2:
            return [{"rule_id": g["_id"], **{k: g[k] for k in ("category", "severity", "priority", "effort", "affected_urls")}} for g in groups.values()]
        return list(groups.values())


def test_seo_audit_archive_round_trip_serves_identical_reads(monkeypatch):
    cols: dict[str, _FakeCol] = {}

    class DB:
        def __getattr__(self, name):
            return cols.setdefault(name, _FakeCol())

        __getitem__ = __getattr__

    db = DB()
    monkeypatch.setattr(storage, "_storage_mode", "mongo")
    monkeypatch.setattr(storage, "get_db", lambda: db)
    monkeypatch.setattr(storage, "_SEO_ARCHIVE_CHUNK_ROWS", 7)  # force several chunks
    storage._seo_archive_cache.clear()
    aid, new = "old1", "new1"
    db.seo_audits.insert_many([
        {"_id": aid, "id": aid, "project_id": "p", "status": "completed", "started_at": "2026-01-01"},
        {"_id": new, "id": new, "project_id": "p", "status": "completed", "started_at": "2026-02-01"},
    ])
    for a in (aid, new):
        db.seo_audit_urls.insert_many([{"_id": f"{a}u{i}", "id": f"{a}u{i}", "audit_id": a, "url": f"https://s.com/{i}", "normalized_url": f"https://s.com/{i}", "crawl_depth": i % 3, "status_code": 200 if i % 5 else 404, "indexability": "indexable", "fetched_at": f"t{i:03d}"} for i in range(30)])
        db.seo_audit_links.insert_many([{"audit_id": a, "type": "anchor", "source_url_id": f"{a}u{i % 30}", "target_url": f"https://s.com/{(i * 7) % 30}"} for i in range(60)])
        db.seo_audit_issues.insert_many([{"audit_id": a, "rule_id": f"r{i % 4}", "severity": "high", "priority": "high", "category": "c", "effort": "low", "url_id": f"{a}u{i}"} for i in range(20)])

    def reads():
        return (
            storage.load_seo_audit_urls_page(aid, page=2, per_page=5, sort="crawl_depth"),
            storage.load_seo_audit_urls_page(aid, status_filter="404"),
            storage.load_seo_audit_url_by_id(f"{aid}u3", aid),
            sorted(storage.aggregate_seo_audit_inlink_counts(aid).items()),
            storage.load_seo_audit_inlinks_for_url(aid, "https://s.com/7"),
            storage.load_seo_audit_outlinks_for_url(aid, f"{aid}u4"),
            len(storage.load_all_seo_audit_links(aid)),
            len(storage.load_all_seo_audit_urls(aid)),
            storage.load_seo_audit_issues(aid, rule_id="r1"),
            sorted(g["rule_id"] for g in storage.aggregate_seo_audit_issue_groups(aid)),
        )

    before = reads()
    assert storage.archive_old_seo_audits("p") == [aid]  # newest audit is never archived
    assert db.seo_audit_links.count_documents({"audit_id": aid}) == 0
    assert db.seo_audit_links.count_documents({"audit_id": new}) == 60
    assert db.seo_audit_archives.count_documents({"audit_id": aid, "kind": "links"}) == 9
    after = reads()
    assert after[0]["total"] == before[0]["total"] and [r["id"] for r in after[0]["items"]] == [r["id"] for r in before[0]["items"]]
    assert after[1]["total"] == before[1]["total"]
    assert after[2:] == before[2:]
    assert storage.archive_old_seo_audits("p") == []  # idempotent
