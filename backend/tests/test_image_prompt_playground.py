"""Self-check for the image-prompt test history's trim-to-N logic in storage.py
(create_image_prompt_test / load_recent_image_prompt_tests) -- the one genuinely
new piece of logic in the Image Prompt Playground feature (the usage-counter
wrapper is a trivial copy of three already-proven monthly-counter wrappers)."""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

import storage  # noqa: E402


def test_image_prompt_test_history_trims_to_five(monkeypatch, tmp_path):
    monkeypatch.setattr(storage, "_storage_mode", "json", raising=False)
    monkeypatch.setattr(storage, "_data_path", lambda filename: str(tmp_path / filename), raising=False)

    project_id = "proj-1"
    image_prompt_id = "ip-1"
    for i in range(7):
        storage.create_image_prompt_test(
            {
                "id": f"test-{i}",
                "project_id": project_id,
                "image_prompt_id": image_prompt_id,
                "prompt_text": f"prompt {i}",
                "final_prompt": f"final {i}",
                "image_url": f"https://example.com/{i}.png",
                "model": "gpt-image-1",
                "created_at": f"2026-01-01 00:00:0{i}",
            }
        )

    recent = storage.load_recent_image_prompt_tests(project_id, image_prompt_id)
    assert len(recent) == 5
    assert [r["id"] for r in recent] == ["test-6", "test-5", "test-4", "test-3", "test-2"]

    # A different prompt id's history is untouched by another prompt's trimming.
    storage.create_image_prompt_test(
        {
            "id": "other-1", "project_id": project_id, "image_prompt_id": "ip-2",
            "prompt_text": "x", "final_prompt": "x", "image_url": "https://example.com/x.png",
            "model": "gpt-image-1", "created_at": "2026-01-01 00:00:00",
        }
    )
    assert len(storage.load_recent_image_prompt_tests(project_id, "ip-2")) == 1
    assert len(storage.load_recent_image_prompt_tests(project_id, image_prompt_id)) == 5


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))
