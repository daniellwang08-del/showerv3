"""Tests for HTML → LLM content preparation (Workable / SPA shell issue)."""

from app.services.ai_parser import AIParser


def test_prepare_uses_semantic_plain_text_for_html_not_prefix_junk():
    p = AIParser()
    html = """<!DOCTYPE html><html><body>
    <header>""" + ("Cookie and nav junk. " * 400) + """</header>
    <div class="job-description">
    <h2>Software Engineer</h2>
    <p>""" + ("Build scalable APIs and mentor engineers. " * 30) + """</p>
    </div>
    </body></html>"""
    out = p._prepare_content_for_llm(html)
    assert "Build scalable APIs" in out
    assert len(out) > 200


def test_prepare_plain_field_unchanged():
    p = AIParser()
    text = "Title: X\n\nWe need a Python developer with five years experience."
    out = p._prepare_content_for_llm(text)
    assert "Python" in out
