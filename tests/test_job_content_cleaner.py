from app.services.job_content_cleaner import plain_text_from_document_html, plain_text_from_fragment_html


def test_extracts_full_page_text():
    html = """
    <html><body>
    <header><h1>Software Engineer</h1></header>
    <main>
    <p>We are looking for a talented engineer to join our team.</p>
    <p>Requirements: Python, PostgreSQL, 5+ years experience.</p>
    </main>
    <footer>Copyright 2026</footer>
    </body></html>
    """
    text = plain_text_from_document_html(html)
    assert "Software Engineer" in text
    assert "talented engineer" in text
    assert "Python" in text
    assert "Copyright" in text


def test_strips_scripts_and_styles():
    html = """
    <html><body>
    <script>var x = 1;</script>
    <style>.foo { color: red; }</style>
    <p>Visible content here.</p>
    </body></html>
    """
    text = plain_text_from_document_html(html)
    assert "Visible content" in text
    assert "var x" not in text
    assert "color: red" not in text


def test_strips_form_inputs():
    html = """
    <html><body>
    <p>Job description text.</p>
    <form>
    <input type="text" value="hidden"/>
    <button>Submit</button>
    <textarea>Notes</textarea>
    </form>
    </body></html>
    """
    text = plain_text_from_document_html(html)
    assert "Job description text" in text
    assert "Submit" not in text
    assert "Notes" not in text


def test_empty_html_returns_empty():
    assert plain_text_from_document_html("") == ""
    assert plain_text_from_document_html(None) == ""


def test_plain_text_from_fragment():
    fragment = "<p>Hello <strong>World</strong></p><br/><p>Second line</p>"
    text = plain_text_from_fragment_html(fragment)
    assert "Hello World" in text
    assert "Second line" in text


def test_fragment_without_html():
    text = plain_text_from_fragment_html("Plain text without tags")
    assert text == "Plain text without tags"


def test_preserves_all_visible_content():
    html = """
    <html><body>
    <header><nav>Navigation</nav></header>
    <main>
    <article class="job-description">
    <h2>About the Role</h2>
    <p>Build APIs in Python.</p>
    </article>
    </main>
    <aside>Related jobs</aside>
    <footer>Contact us</footer>
    </body></html>
    """
    text = plain_text_from_document_html(html)
    assert "Navigation" in text
    assert "About the Role" in text
    assert "Build APIs" in text
    assert "Related jobs" in text
    assert "Contact us" in text
