from app.services.article_selection_rewrite import _build_selection_rewrite_messages


def test_system_prompt_has_fidelity_language():
    sys_prompt, _ = _build_selection_rewrite_messages(
        selected_text="Widgets are useful.",
        context_before="",
        context_after="",
        focus_keyphrase="widgets",
        keywords=["widgets", "gadgets"],
    )
    lowered = sys_prompt.lower()
    assert "preserve every fact" in lowered
    assert "do not invent" in lowered
    assert "only the wording" in lowered


def test_user_message_carries_all_context_fields():
    _, user = _build_selection_rewrite_messages(
        selected_text="Widgets are useful.",
        context_before="Before this sentence.",
        context_after="After this sentence.",
        focus_keyphrase="widgets guide",
        keywords=["widgets", "gadgets"],
    )
    assert "Widgets are useful." in user
    assert "Before this sentence." in user
    assert "After this sentence." in user
    assert "widgets guide" in user
    assert "gadgets" in user
