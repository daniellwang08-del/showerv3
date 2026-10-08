"""Detect fetched pages that are not an open job posting.

Job URLs often resolve to something other than a description: a bot wall, an
error shell, a filled or expired notice, a login screen, a bare application
form, an unrendered template, or a careers index. Extraction must not cache
those as a job, and scoring must not rate them against a profile.

Every phrase below is the page's own wording. A phrase only condemns a page
when the text lacks a real description body (several section headings such
as "Responsibilities" or "Requirements"), so a genuine posting with "Sign in"
in its header or "Something went wrong" in a widget is kept. Closed notices
are stronger: near the top of the page they win even over a body, because
filled postings often keep the old description below the banner.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_HEAD_CHARS = 1500
_SCAN_CHARS = 6000

_BLOCKED = re.compile(
    r"just a moment\.\.\."
    r"|performing security verification"
    r"|checking (?:if the site connection is secure|your browser before accessing)"
    r"|verify(?:ing)? (?:that )?you are (?:a )?human"
    r"|are you a robot"
    r"|cloudflare ray id"
    r"|you have been blocked"
    r"|access (?:is )?temporarily restricted"
    r"|human verification"
    r"|\bhcaptcha\b"
    r"|\brecaptcha\b[^\n]{0,40}(?:verify|challenge)"
    r"|solve (?:a|the|this) puzzle"
    r"|press (?:and|&) hold"
    r"|access denied"
    r"|403 forbidden"
    r"|you don't have permission to access"
    r"|request (?:was |has been )?blocked"
    r"|unusual traffic from your (?:computer|network)"
    r"|is parked free"
    r"|this domain (?:is|may be) for sale"
    r"|content is blocked",
    re.I,
)

_ERROR = re.compile(
    r"something went wrong\.? please (?:refresh|try again)"
    r"|we(?:'re| are) sorry\.? something went wrong"
    r"|failed to load (?:environment|the page|job)"
    r"|(?:^|\n)\s*job not found\b"
    r"|the (?:job|position|posting) you (?:requested|are looking for|were looking for) (?:was|could) not (?:be )?found"
    r"|(?:this )?page (?:was |could not be |cannot be )?not found"
    r"|the page you (?:are|were|'re) looking for (?:may have|has|does not|doesn't|could not|can't|cannot|no longer)"
    r"|\b404\b[^\n]{0,40}(?:error|not found|page)"
    r"|(?:an )?unexpected error (?:has )?occurred"
    r"|javascript is required"
    r"|(?:please )?enable javascript",
    re.I,
)

_CLOSED = re.compile(
    r"this (?:job|position|posting|role|requisition|vacancy|opening)(?: posting)? (?:has been|is|was) (?:closed|filled|removed|expired|no longer (?:available|open|active|accepting))"
    r"|(?:job|position|posting|role|vacancy) (?:is )?no longer (?:available|open|active|accepting applications)"
    r"|(?:is|are) no longer accepting (?:applications|candidates|responses)"
    r"|no longer accepting applications"
    r"|not currently accepting applications for this (?:position|job|role)"
    r"|this (?:job|job posting|posting|listing|vacancy) has expired"
    r"|(?:^|\n)\s*applications? (?:are |is )?closed\b"
    r"|the application (?:window|deadline) (?:has )?(?:closed|passed)"
    r"|this job (?:is no longer|has been taken down)"
    r"|position (?:has been )?filled\b",
    re.I,
)

# Phenom ships this block in the server HTML of every job page and hides it
# client-side for open jobs, so it only counts when nothing else is there.
_CLOSED_TEMPLATE = re.compile(
    r"(?:job|position|role) you are trying to (?:apply for|view) (?:has been filled|is no longer|has expired|has been closed)",
    re.I,
)

_LOGIN = re.compile(
    r"sign in \| indeed accounts"
    r"|create an account or sign in"
    r"|(?:please )?(?:log\s*in|sign\s*in) to (?:your account|view|continue|see|apply)"
    r"|(?:log\s*in|sign\s*in) (?:required|to view this job)"
    r"|create (?:a free )?account to (?:view|apply|continue)"
    r"|(?:^|\n)\s*single sign[- ]on\b"
    r"|(?:^|\n)\s*(?:forgot (?:your )?password\??)\s*(?:$|\n)",
    re.I,
)

_UNRENDERED = re.compile(r"\{\{\s*[\w$.\[\]'\"()|: -]{1,80}\}\}")

_LOADING_ONLY = re.compile(r"(?:loading|please wait|initializing)\W*$", re.I)

_CAREERS_INDEX = re.compile(
    r"current openings at\b"
    r"|thanks for checking out our (?:job )?openings"
    r"|(?:^|\n)\s*(?:current|open) (?:openings|positions|roles)\s*(?:\(\d+\))?\s*(?:$|\n)"
    r"|(?:^|\n)\s*all open roles\s*(?:$|\n)"
    r"|(?:^|\n)\s*\d+ (?:open )?(?:jobs|positions|roles) found\b"
    r"|(?:^|\n)\s*search (?:all )?jobs\s*(?:$|\n)",
    re.I,
)

_FORM_LABELS = re.compile(
    r"(?:^|\n)\s*(?:first name|last name|full name|legal name|e-?mail(?: address)?|phone(?: number)?"
    r"|resume(?:/cv)?|cv|cover letter|linkedin(?: profile| url)?|portfolio|website"
    r"|upload (?:resume|cv|file)|attach(?: resume| cv)?|submit application|apply now"
    r"|current company|current location|how did you hear about us)\s*\*?\s*(?:$|\n)",
    re.I,
)

# Pages often fuse a heading into the next sentence ("Key ResponsibilitiesBuild"),
# so these match anywhere a word starts rather than only at line starts.
_JD_HEADINGS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(rf"\b{p}", re.I)
    for p in (
        r"responsibilit",
        r"(?:requirements|qualifications)",
        r"what you(?:'ll|\u2019ll| will) (?:do|be doing|work on|bring|need)",
        r"what (?:we(?:'re|\u2019re| are)) looking for",
        r"what we (?:offer|provide)",
        r"about (?:the|this) (?:role|job|position|opportunity)",
        r"about you\s*(?::|\n|$)",
        r"who you are\b",
        r"(?:benefits|perks)\b",
        r"(?:nice|good) to have",
        r"(?:job|role|position) (?:description|summary|overview|purpose)",
        r"(?:duties|essential functions|day[- ]to[- ]day)",
        r"(?:compensation|salary|pay range)\b",
        r"you (?:have|bring|will)\b",
        r"(?:must|should) have\b",
        r"(?:skills|experience) (?:required|needed)",
    )
)
_EXPERIENCE_CUE = re.compile(r"\b\d+\+?\s*(?:-\s*\d+\s*)?years?(?: of)? (?:\w+ ){0,3}experience\b", re.I)

_MIN_BODY_CHARS = 700
_THIN_CHARS = 600
_THIN_STRUCTURED_CHARS = 150
_FORM_MAX_CHARS = 1800
_CHROME_ONLY_CHARS = 1600

_SENTENCE = re.compile(r"[A-Za-z][^.!?\n]{50,}[.!?]")
_BOILERPLATE = re.compile(
    r"cookie|privacy|copyright|terms of use|all rights reserved|accommodation|equal opportunity"
    r"|browser|javascript|tracking technolog",
    re.I,
)

_DESCRIPTIONS = {
    "blocked": "the site showed bot protection instead of the posting",
    "error_page": "the site returned an error page instead of the posting",
    "closed": "the posting has been closed or filled",
    "not_found": "the page no longer exists",
    "login_wall": "the posting is behind a login",
    "apply_form": "the link opens an application form without the job description",
    "unrendered": "the page did not render its content",
    "careers_index": "the page is a careers index, not a single posting",
    "too_thin": "the page has almost no text and no job description",
}


@dataclass(frozen=True)
class PageIssue:
    reason: str
    evidence: str
    # Wording that template-driven sites ship on open pages too; it explains a
    # page with no description but never outranks text from another source.
    weak: bool = False

    @property
    def description(self) -> str:
        return describe_page_issue(self.reason)


def describe_page_issue(reason: str) -> str:
    return _DESCRIPTIONS.get(reason, reason.replace("_", " "))


def jd_signal_count(text: str) -> int:
    """Distinct description section headings, plus one for an experience cue."""
    sample = text[:20000]
    count = sum(1 for pat in _JD_HEADINGS if pat.search(sample))
    if _EXPERIENCE_CUE.search(sample):
        count += 1
    return count


def has_description_body(text: str) -> bool:
    return len(text) >= _MIN_BODY_CHARS and jd_signal_count(text) >= 2


def _hit(pattern: re.Pattern[str], text: str) -> str | None:
    m = pattern.search(text)
    return " ".join(m.group(0).split())[:80] if m else None


def classify_page(text: str | None) -> PageIssue | None:
    """Why *text* is not an open job description, or None when it is one."""
    body = (text or "").strip()
    if not body:
        return PageIssue("too_thin", "empty page")
    head = body[:_HEAD_CHARS]
    scan = body[:_SCAN_CHARS]
    has_body = has_description_body(body)

    closed = _hit(_CLOSED, head)
    if closed:
        return PageIssue("closed", closed)
    if has_body:
        return None
    closed = _hit(_CLOSED, scan)
    if closed:
        return PageIssue("closed", closed)
    templated = _hit(_CLOSED_TEMPLATE, scan)
    if templated:
        return PageIssue("closed", templated, weak=True)

    for reason, pattern in (
        ("blocked", _BLOCKED),
        ("error_page", _ERROR),
        ("login_wall", _LOGIN),
    ):
        found = _hit(pattern, scan)
        if found:
            if reason == "error_page" and re.search(r"not found|looking for", found, re.I):
                return PageIssue("not_found", found)
            return PageIssue(reason, found)

    placeholders = _UNRENDERED.findall(scan)
    if len(placeholders) >= 3:
        return PageIssue("unrendered", " ".join(placeholders[:3])[:80])
    if len(body) < 400 and _LOADING_ONLY.search(body):
        return PageIssue("unrendered", "Loading...")

    index = _hit(_CAREERS_INDEX, head)
    if index:
        return PageIssue("careers_index", index)

    if len(body) < _FORM_MAX_CHARS:
        labels = {m.strip().lower().rstrip("*").strip() for m in _FORM_LABELS.findall(scan)}
        if len(labels) >= 4:
            return PageIssue("apply_form", ", ".join(sorted(labels)[:4]))

    # Vendor and JSON-LD texts start with "Title:" and are terse by design.
    structured = body.startswith("Title:")
    signals = jd_signal_count(body)
    if structured:
        if len(body) < _THIN_STRUCTURED_CHARS and signals == 0:
            return PageIssue("too_thin", f"{len(body)} chars")
        return None
    if len(body) < _THIN_CHARS and signals <= 1:
        return PageIssue("too_thin", f"{len(body)} chars")
    if len(body) < _CHROME_ONLY_CHARS and signals <= 1 and _prose_sentences(body) < 2:
        return PageIssue("too_thin", "navigation and boilerplate only")

    return None


def _prose_sentences(text: str) -> int:
    """Sentences that read like content rather than cookie, legal or footer copy."""
    return sum(
        1 for m in _SENTENCE.finditer(text) if not _BOILERPLATE.search(m.group(0))
    )


def non_posting_reason(text: str | None) -> str | None:
    """The ``classify_page`` reason for stored text, or None for a usable posting."""
    if not (text or "").strip():
        return None
    issue = classify_page(text)
    return issue.reason if issue else None
