"""Self-checks for the Cloudinary media backfill script's safety-critical logic:

1. --dry-run must never call upload_image_bytes or patch_article_fields -- it's the
   safety rail a production run is checked against before any real write happens.
2. Storage-mode routing picks the right source for each legacy featured-image mode.
3. Inline data: URL decoding round-trips.
"""

import base64
import importlib
import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

backfill = importlib.import_module("app.scripts.backfill_cloudinary_media")


def test_decode_inline_data_url_round_trips():
    raw_bytes = b"fake-png-bytes"
    data_url = "data:image/png;base64," + base64.b64encode(raw_bytes).decode("ascii")
    decoded = backfill._decode_inline_data_url(data_url)
    assert decoded == (raw_bytes, "image/png")


def test_decode_inline_data_url_rejects_non_data_url():
    assert backfill._decode_inline_data_url("https://example.com/x.png") is None


def test_migrate_featured_image_skips_already_cloudinary_without_any_io():
    article = {"id": "a1", "featured_image_storage": "cloudinary"}
    with patch.object(backfill, "upload_image_bytes") as mock_upload, \
         patch.object(backfill.st, "patch_article_fields") as mock_patch:
        result = backfill._migrate_featured_image(article, dry_run=False, delete_local=False)
    assert result == "skip-already-cloudinary"
    mock_upload.assert_not_called()
    mock_patch.assert_not_called()


def test_migrate_featured_image_dry_run_never_uploads_or_writes():
    article = {"id": "a1", "featured_image_storage": "file"}
    with patch.object(backfill, "_read_local_featured_image", return_value=(b"bytes", "image/png")), \
         patch.object(backfill, "upload_image_bytes") as mock_upload, \
         patch.object(backfill.st, "patch_article_fields") as mock_patch:
        result = backfill._migrate_featured_image(article, dry_run=True, delete_local=False)
    assert result.startswith("would-migrate")
    mock_upload.assert_not_called()
    mock_patch.assert_not_called()


def test_migrate_featured_image_inline_mode_decodes_and_uploads():
    raw_bytes = b"fake-bytes"
    data_url = "data:image/jpeg;base64," + base64.b64encode(raw_bytes).decode("ascii")
    article = {"id": "a1", "featured_image_storage": "inline", "image_url": data_url}
    with patch.object(backfill, "upload_image_bytes", return_value={"secure_url": "https://cdn/x.jpg", "public_id": "pid"}) as mock_upload, \
         patch.object(backfill.st, "patch_article_fields", return_value=True) as mock_patch:
        result = backfill._migrate_featured_image(article, dry_run=False, delete_local=False)
    assert result == "migrated"
    mock_upload.assert_called_once()
    assert mock_upload.call_args[0][0] == raw_bytes
    mock_patch.assert_called_once_with("a1", {
        "image_url": "https://cdn/x.jpg",
        "featured_image_cloudinary_public_id": "pid",
        "featured_image_storage": "cloudinary",
    })


def test_migrate_featured_image_failed_upload_does_not_touch_db():
    article = {"id": "a1", "featured_image_storage": "file"}
    with patch.object(backfill, "_read_local_featured_image", return_value=(b"bytes", "image/png")), \
         patch.object(backfill, "upload_image_bytes", return_value=None), \
         patch.object(backfill.st, "patch_article_fields") as mock_patch:
        result = backfill._migrate_featured_image(article, dry_run=False, delete_local=False)
    assert result == "failed-upload"
    mock_patch.assert_not_called()


if __name__ == "__main__":
    import pytest

    pytest.main([__file__, "-v"])
