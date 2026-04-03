from app.services.job_content_cleaner import plain_text_from_document_html, rank_document_html_for_extraction


def test_plain_text_best_of_prefers_longer_job_body():
    html = """
    <html><body>
    <div class="content">Sidebar promo text here.</div>
    <div class="job-description">""" + (
        "Main job duties. " * 80
    ) + """</div>
    </body></html>
    """
    text = plain_text_from_document_html(html)
    assert len(text) >= 80
    assert "Main job duties" in text
    assert len(text) > len("Sidebar promo text here.")


def test_readability_uses_chrome_stripped_html_not_footer():
    """Footer removed from tree must not be the Readability 'article' (EEO spam)."""
    eeo = (
        "We are an equal opportunity employer and do not discriminate in any form. "
        "Race, color, religion, national origin, gender identity, sexual orientation, "
        "protected veteran, disability status. Reasonable accommodation. "
    ) * 30
    html = f"""
    <html><body>
    <main><h1>Software Engineer</h1>
    <p>Build APIs in Python. You will ship features daily. Collaborate with the team.</p>
    </main>
    <footer>{eeo}</footer>
    </body></html>
    """
    text = plain_text_from_document_html(html)
    assert "Build APIs" in text
    assert "equal opportunity employer" not in text.lower()


def test_prefers_job_description_over_long_boilerplate_content_region():
    """Shorter real JD must beat longer generic .content that is mostly EEO boilerplate."""
    boilerplate = (
        "We are an equal opportunity employer. Equal employment opportunity. "
        "Does not discriminate. Race, color, religion, national origin. "
        "Genetic information. Gender identity. Sexual orientation. "
        "Protected veteran. Reasonable accommodation. Disability status. "
        "EEO is the law. OFCCP. Affirmative action. Applicants will receive consideration. "
    ) * 8
    html = f"""
    <html><body>
    <div class="job-description">
    Senior Backend Engineer. Design distributed systems. Python, PostgreSQL, Kafka.
    On-call rotation. Remote friendly.
    </div>
    <div class="content">{boilerplate}</div>
    </body></html>
    """
    text = plain_text_from_document_html(html)
    assert "Backend Engineer" in text
    assert "PostgreSQL" in text
    assert text.count("equal opportunity") <= 2


def test_workable_data_ui_sections_match_without_job_description_class():
    """Workable uses data-ui on section; class is hashed (e.g. styles--3vx-H), not .job-description."""
    html = """
    <html><body><main>
    <section data-ui="job-description">
    <p>We need Django expertise for high-scale APIs.</p>
    <p><strong>What you'll do:</strong></p>
    <ul><li>Ship features</li></ul>
    </section>
    <footer>SchooLinks does not discriminate on the basis of race, sex, color, religion.</footer>
    </main></body></html>
    """
    text = plain_text_from_document_html(html)
    assert "Django" in text
    assert "What you'll do" in text or "Ship features" in text
    assert "does not discriminate" not in text.lower()


def test_plain_text_rejects_cmp_cookie_banner_only():
    """Do not return cookie/CMP copy as the job body (browser may still fix via dismissal)."""
    html = """
    <html><body>
    <main>
    This website uses cookies to improve user's experience, personalise ads and analyse traffic.
    You can accept all cookies, decline all optional cookies, or manage your cookie settings.
    To learn more, view our cookies policy.
    </main>
    </body></html>
    """
    assert plain_text_from_document_html(html) == ""


def test_plain_text_rejects_hubspot_style_cookie_notice():
    """HubSpot EU banner copy must not be treated as the job description."""
    html = """
    <html><body>
    <div id="hs-eu-cookie-confirmation-inner">
    This website stores cookies on your computer. These cookies are used to collect information
    about how you interact with our website and allow us to remember you. We use this information
    in order to improve and customize your browsing experience and for analytics and metrics
    about our visitors both on this website and other media. To find out more about the cookies
    we use, see our Privacy Policy.
    </div>
    </body></html>
    """
    assert plain_text_from_document_html(html) == ""


def test_rank_document_html_zero_when_plain_empty():
    assert rank_document_html_for_extraction("") == 0.0
    assert rank_document_html_for_extraction("<html><body></body></html>") == 0.0


def test_rank_document_html_prefers_substantive_jd_over_shell():
    """Frame selection uses rank: a real JD scores higher than a long cookie/EEO shell."""
    shell = """
    <html><body><header>Careers</header>
    <p>This website uses cookies. Accept all cookies. Manage cookie settings. Cookies policy.</p>
    <p>We are an equal opportunity employer. Race, color, religion, national origin.</p>
    </body></html>
    """
    jd = """
    <html><body><main class="job-description">
    <h1>Security Engineer</h1>
    <p><strong>Responsibilities:</strong></p><ul>
    <li>Design detection pipelines</li><li>Python, cloud infrastructure</li></ul>
    <p><strong>Requirements:</strong></p><ul><li>5+ years experience</li></ul>
    </main></body></html>
    """
    assert rank_document_html_for_extraction(jd) > rank_document_html_for_extraction(shell)
