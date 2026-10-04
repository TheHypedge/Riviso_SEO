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


def test_no_custom_instruction_leaves_prompt_unchanged():
    baseline, _ = _build_selection_rewrite_messages(
        selected_text="Widgets are useful.",
        context_before="",
        context_after="",
        focus_keyphrase="widgets",
        keywords=[],
    )
    with_none, _ = _build_selection_rewrite_messages(
        selected_text="Widgets are useful.",
        context_before="",
        context_after="",
        focus_keyphrase="widgets",
        keywords=[],
        custom_instruction=None,
    )
    with_blank, _ = _build_selection_rewrite_messages(
        selected_text="Widgets are useful.",
        context_before="",
        context_after="",
        focus_keyphrase="widgets",
        keywords=[],
        custom_instruction="   ",
    )
    assert with_none == baseline
    assert with_blank == baseline


def test_custom_instruction_appends_priority_block():
    sys_prompt, _ = _build_selection_rewrite_messages(
        selected_text="Widgets are useful.",
        context_before="",
        context_after="",
        focus_keyphrase="widgets",
        keywords=[],
        custom_instruction="Make this punchier",
    )
    assert "Make this punchier" in sys_prompt
    assert "follow it exactly" in sys_prompt.lower()
    # The fidelity rules must still be present (the instruction only overrides
    # them where it conflicts, it doesn't replace the base prompt).
    assert "preserve every fact" in sys_prompt.lower()
