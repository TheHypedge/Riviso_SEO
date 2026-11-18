"""Post authors: resolution order, publish payloads, old-plugin repair, author listing + cache."""
import asyncio

import pytest

from app.services import authors as au
from app.services.wordpress_publish import publish_post_to_wordpress, update_post_on_wordpress


def test_resolution_order_article_then_project_then_wordpress():
    proj = {"default_wp_author_id": 7, "default_wp_author_name": "Adv. Mehta", "default_shopify_author": "Riya"}
    assert au.resolve_wp_author({"wp_author_id": 3, "wp_author_name": "Asha"}, proj) == (3, "Asha")
    assert au.resolve_wp_author({}, proj) == (7, "Adv. Mehta")
    assert au.resolve_wp_author({"wp_author_id": None}, {}) == (None, "")
    assert au.resolve_wp_author({"wp_author_id": "0"}, {"default_wp_author_id": "x"}) == (None, "")
    assert au.resolve_shopify_author({"shopify_author": "Kabir"}, proj) == "Kabir"
    assert au.resolve_shopify_author({}, proj) == "Riya"


def test_author_updates_only_touch_sent_fields():
    assert au.author_updates(au.AuthorChoice()) == {}
    assert au.author_updates(au.AuthorChoice(wp_author_id=5, wp_author_name=" Asha ")) == {"wp_author_id": 5, "wp_author_name": "Asha"}
    assert au.author_updates(au.AuthorChoice(wp_author_id=0, wp_author_name="x")) == {"wp_author_id": None, "wp_author_name": ""}
    assert au.author_updates(au.AuthorChoice(shopify_author=" Kabir ")) == {"shopify_author": "Kabir"}
    with pytest.raises(Exception):
        au.AuthorChoice(wp_author_id=-1)


def test_applied_fields_record_what_wordpress_did():
    assert au.applied_author_fields({"id": 1, "author": 9}, 9, "Asha") == {"wp_author_applied_id": 9, "wp_author_id": 9, "wp_author_name": "Asha"}
    # WordPress fell back to the connected user: the choice is kept, the mismatch is visible
    assert au.applied_author_fields({"id": 1, "author": 2}, 9, "Asha")["wp_author_applied_id"] == 2
    assert au.applied_author_fields({"id": 1}, None, "") == {"wp_author_applied_id": None}


class FakeWP:
    """Records calls; plugin answers like a given connector version."""

    def __init__(self, plugin_reports_author=True, plugin_authors=True):
        self.calls = []
        self.plugin_reports_author = plugin_reports_author
        self.plugin_authors = plugin_authors

    async def ensure_resolved_site_url(self):
        return "https://site.com"

    async def post_json(self, path, body, timeout=30.0):
        self.calls.append(("POST", path, dict(body)))
        if path.endswith("/publish") or path.endswith("/update"):
            out = {"id": 55, "link": "https://site.com/p/", "status": body.get("status") or "draft"}
            if self.plugin_reports_author:
                out["author"] = body.get("author") or 1
            return out
        if path.startswith("/wp-json/wp/v2/posts/55"):
            return {"id": 55, "author": body.get("author")}
        raise AssertionError(path)

    async def put_json(self, path, body, timeout=30.0):
        raise AssertionError("not expected")

    async def get_json(self, path, timeout=20.0):
        self.calls.append(("GET", path, {}))
        if "/riviso/v1/authors" in path:
            if not self.plugin_authors:
                raise RuntimeError("404")
            return {"authors": [{"id": 4, "name": "Zed"}, {"id": 2, "name": "Asha"}], "current": {"id": 1, "name": "Admin"}, "can_assign": True}
        if "/auto-articles/v1/authors" in path:
            raise RuntimeError("404")
        if path.startswith("/wp-json/wp/v2/users/me"):
            return {"id": 1, "name": "Admin", "capabilities": {"edit_others_posts": True}}
        if path.startswith("/wp-json/wp/v2/users?"):
            return [{"id": 2, "name": "Asha", "slug": "asha"}]
        raise AssertionError(path)


def test_publish_sends_author_to_plugin():
    wp = FakeWP()
    created = asyncio.run(publish_post_to_wordpress(wp, post_type="posts", payload={"title": "T", "content": "C", "status": "publish", "author": 9}))
    assert wp.calls[0][1] == "/wp-json/riviso/v1/publish" and wp.calls[0][2]["author"] == 9
    assert created["author"] == 9 and len(wp.calls) == 1  # no repair call needed


def test_old_plugin_that_ignores_author_is_repaired_via_core_rest():
    wp = FakeWP(plugin_reports_author=False)
    created = asyncio.run(publish_post_to_wordpress(wp, post_type="posts", payload={"title": "T", "content": "C", "status": "publish", "author": 9}))
    assert wp.calls[-1] == ("POST", "/wp-json/wp/v2/posts/55", {"author": 9})
    assert created["author"] == 9


def test_no_author_means_no_author_field_and_no_extra_call():
    wp = FakeWP(plugin_reports_author=False)
    asyncio.run(publish_post_to_wordpress(wp, post_type="posts", payload={"title": "T", "content": "C", "status": "draft"}))
    assert "author" not in wp.calls[0][2] and len(wp.calls) == 1
    asyncio.run(update_post_on_wordpress(wp, post_type="posts", wp_post_id=55, payload={"title": "T"}))
    assert "author" not in wp.calls[-1][2]


def test_list_authors_plugin_then_core_fallback_and_cache(monkeypatch):
    au._authors_cache.clear()
    holder = {"wp": FakeWP()}
    monkeypatch.setattr("app.services.wordpress_client.WordpressClient", lambda **kw: holder["wp"])
    proj = {"id": "p1", "wp_site_url": "https://site.com", "wp_username": "admin", "wp_app_password": "abcd efgh"}
    data = asyncio.run(au.list_wp_authors(proj))
    assert data["source"] == "plugin" and [a["name"] for a in data["authors"]] == ["Asha", "Zed"] and data["can_assign"]
    n = len(holder["wp"].calls)
    assert asyncio.run(au.list_wp_authors(proj))["cached"] is True and len(holder["wp"].calls) == n  # no WP round-trip
    holder["wp"] = FakeWP(plugin_authors=False)
    data = asyncio.run(au.list_wp_authors(proj, refresh=True))
    assert data["source"] == "core" and data["current"]["id"] == 1 and data["can_assign"]
    assert {a["id"] for a in data["authors"]} == {1, 2}  # connected user always listed
    assert asyncio.run(au.list_wp_authors({"id": "x"}))["source"] == "not_connected"


def test_shopify_author_list_is_cleaned():
    assert au.clean_shopify_authors([" Riya  Sen ", "riya sen", "", "Kabir"] + [f"a{i}" for i in range(30)])[:2] == ["Riya Sen", "Kabir"]
    assert len(au.clean_shopify_authors([f"a{i}" for i in range(30)])) == au.MAX_SHOPIFY_AUTHORS


def test_scheduler_publish_sends_resolved_author(monkeypatch):
    from app.services import scheduler as sch

    sent = []

    async def fake_publish(wp, *, post_type, payload):
        sent.append(payload)
        return {"id": 1, "author": payload.get("author") or 1}

    async def no_media(*a, **kw):
        return None

    class WPStub:
        def __init__(self, **kw):
            pass

        async def ensure_tag_ids(self, *a, **kw):
            return []

    monkeypatch.setattr("app.services.wordpress_publish.publish_post_to_wordpress", fake_publish)
    monkeypatch.setattr(sch, "resolve_featured_media_id", no_media)
    monkeypatch.setattr(sch, "WordpressClient", WPStub)
    proj = {"wp_verified_status": "connected", "wp_site_url": "https://s.com", "wp_username": "u", "wp_app_password": "p",
            "default_wp_author_id": 7, "default_wp_author_name": "Def"}
    art = {"title": "T", "article": "Body", "keywords": []}
    run = lambda a, p=proj: asyncio.run(sch.publish_article_to_wordpress(st=object(), proj=p, article=a, post_type="posts", wp_status="publish", category_ids=[]))
    run({**art, "wp_author_id": 3})
    run(art)
    run(art, {k: v for k, v in proj.items() if not k.startswith("default_wp_author")})
    assert [p.get("author") for p in sent] == [3, 7, None]
