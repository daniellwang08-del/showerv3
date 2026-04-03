from app.services.extraction_merge import (
    description_len,
    is_rich_description,
    merge_structured_job_data,
    RICH_DESCRIPTION_MIN_CHARS,
    skip_early_static_html_exit,
)


def test_merge_prefers_longer_description():
    a = {"title": "T", "description": "short", "company": "Co"}
    b = {"description": "x" * 100, "location": "NY"}
    m = merge_structured_job_data(a, b)
    assert m is not None
    assert len(m["description"]) == 100
    assert m["company"] == "Co"
    assert m["location"] == "NY"


def test_is_rich_uses_threshold():
    assert not is_rich_description({"description": "x" * (RICH_DESCRIPTION_MIN_CHARS - 1)})
    assert is_rich_description({"description": "x" * RICH_DESCRIPTION_MIN_CHARS})


def test_description_len():
    assert description_len(None) == 0
    assert description_len({"description": "  hi  "}) == 2


def test_skip_early_static_for_workable_and_embed_params():
    assert skip_early_static_html_exit("https://apply.workable.com/acme/j/ABC123/") is True
    assert skip_early_static_html_exit("https://vesta.com/careers?ashby_jid=deee60e6-d180-41aa-8d0e-f7e9e4baf0ba") is True
    assert skip_early_static_html_exit("https://corp.com/jobs?gh_jid=123") is True


def test_skip_early_false_for_generic_careers():
    assert skip_early_static_html_exit("https://example.com/careers/engineer") is False
