"""Self-checks for the Cloudinary media-cleanup work:

1. _cleanup_article_media (storage.py) correctly orchestrates deleting each article's
   featured-image Cloudinary asset + local disk file, and inline article-media, for a
   batch of articles -- the shared helper both delete_articles_by_ids and
   delete_project_and_resources route through, which is what makes account deletion
   (purge_user_data -> delete_project_and_resources) get the same cleanup for free.
2. get_article_image_url's read-order fix: image_url (a real URL, e.g. Cloudinary) must
   win over a stale local disk file, not the other way around -- otherwise a disk file
   left over from before Cloudinary was connected would shadow a newer image forever.
"""

import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import storage as storage_module  # noqa: E402


def test_cleanup_article_media_deletes_cloudinary_assets_and_disk_files(tmp_path, monkeypatch):
    # Point the module's disk-image dir at a scratch directory for this test only.
    monkeypatch.setattr(storage_module, "_article_images_dir", lambda ensure=False: str(tmp_path))

    # Article A has a Cloudinary-backed featured image; article B has a legacy disk file.
    disk_png = tmp_path / "article-b.png"
    disk_png.write_bytes(b"fake-png")
    disk_meta = tmp_path / "article-b.png.meta.json"
    disk_meta.write_text("{}")

    articles = [
        {"id": "article-a", "featured_image_cloudinary_public_id": "riviso/articles/article-a/featured"},
        {"id": "article-b", "featured_image_cloudinary_public_id": ""},
    ]

    deleted_public_ids = []
    with patch("app.services.cloudinary_storage.delete_by_public_id", side_effect=deleted_public_ids.append), \
         patch("app.services.article_media_storage.delete_media_for_articles") as mock_delete_inline:
        storage_module._cleanup_article_media(articles)

    assert deleted_public_ids == ["riviso/articles/article-a/featured"]
    mock_delete_inline.assert_called_once_with(["article-a", "article-b"])
    assert not disk_png.exists()
    assert not disk_meta.exists()


def test_cleanup_article_media_is_best_effort_on_cloudinary_failure(tmp_path, monkeypatch):
    """A failed Cloudinary delete must never raise out of cleanup -- it's called right
    before the real article-row deletion, which must always proceed."""
    monkeypatch.setattr(storage_module, "_article_images_dir", lambda ensure=False: str(tmp_path))
    articles = [{"id": "article-a", "featured_image_cloudinary_public_id": "some/public/id"}]

    with patch("app.services.cloudinary_storage.delete_by_public_id", side_effect=RuntimeError("network down")), \
         patch("app.services.article_media_storage.delete_media_for_articles"):
        storage_module._cleanup_article_media(articles)  # must not raise


def test_cleanup_article_media_noop_on_empty_list():
    with patch("app.services.cloudinary_storage.delete_by_public_id") as mock_delete, \
         patch("app.services.article_media_storage.delete_media_for_articles") as mock_delete_inline:
        storage_module._cleanup_article_media([])
    mock_delete.assert_not_called()
    mock_delete_inline.assert_not_called()


def test_get_article_image_url_prefers_image_url_over_stale_disk_file(monkeypatch):
    """The read-order fix: a populated image_url (e.g. a real Cloudinary URL) must win
    over a local disk file, even when one still exists from before Cloudinary was
    connected -- otherwise the stale file shadows the real image forever."""
    monkeypatch.setattr(storage_module, "_storage_mode", "json")
    monkeypatch.setattr(
        storage_module, "get_article",
        lambda *, project_id, article_id: {"id": article_id, "image_url": "https://res.cloudinary.com/demo/real.png"},
    )

    def _fail_if_called(*_a, **_kw):
        raise AssertionError("disk fallback should never be consulted when image_url is set")

    monkeypatch.setattr(storage_module, "featured_image_file_exists", _fail_if_called)
    monkeypatch.setattr(storage_module, "_load_featured_image_file_as_data_url", _fail_if_called)

    result = storage_module.get_article_image_url(project_id="proj-1", article_id="art-1")
    assert result == "https://res.cloudinary.com/demo/real.png"


def test_get_article_image_url_falls_back_to_disk_when_image_url_empty(monkeypatch):
    monkeypatch.setattr(storage_module, "_storage_mode", "json")
    monkeypatch.setattr(
        storage_module, "get_article",
        lambda *, project_id, article_id: {"id": article_id, "image_url": ""},
    )
    monkeypatch.setattr(storage_module, "featured_image_file_exists", lambda aid: True)
    monkeypatch.setattr(storage_module, "_load_featured_image_file_as_data_url", lambda aid: "data:image/png;base64,AAAA")

    result = storage_module.get_article_image_url(project_id="proj-1", article_id="art-1")
    assert result == "data:image/png;base64,AAAA"


if __name__ == "__main__":
    import pytest

    pytest.main([__file__, "-v"])
