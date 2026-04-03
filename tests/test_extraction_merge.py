from app.services.extraction_merge import pick_best_text


def test_pick_best_text_chooses_longest():
    candidates = [
        ("short text", "static_html"),
        ("x" * 200, "api_vendor"),
        ("y" * 100, "api_json_ld"),
    ]
    text, method = pick_best_text(candidates)
    assert len(text) == 200
    assert method == "api_vendor"


def test_pick_best_text_skips_short():
    candidates = [
        ("too short", "static_html"),
        ("also short", "api_vendor"),
    ]
    text, method = pick_best_text(candidates)
    assert text == ""
    assert method == "none"


def test_pick_best_text_empty_candidates():
    text, method = pick_best_text([])
    assert text == ""
    assert method == "none"


def test_pick_best_text_min_threshold():
    candidates = [
        ("x" * 49, "static_html"),
        ("y" * 50, "api_json_ld"),
    ]
    text, method = pick_best_text(candidates)
    assert len(text) == 50
    assert method == "api_json_ld"
