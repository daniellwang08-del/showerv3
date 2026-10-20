"""Find application verification codes (email OTPs) in the user's inbox.

Some ATSs (Greenhouse most often) email a one-time security code after the
application is submitted and only accept the application once it is typed back
in. Auto-apply polls this while the form waits on the code.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

from app.core.logging import get_logger
from app.services import nylas_service

logger = get_logger(__name__)

# Look back at most this far, whatever the caller asks for.
MAX_LOOKBACK = timedelta(minutes=30)
# Allowance for clock skew between the browser and the mail provider.
SINCE_SLACK = timedelta(seconds=120)
MAX_MESSAGES = 25
MAX_BODY_FETCHES = 6

_KEYWORD = re.compile(
    r"\b(verification|verify|security|confirmation|one[-\s]?time|access|login|sign[-\s]?in)\s+(code|pin|passcode)\b"
    r"|\bpasscode\b|\botp\b|\bcode\s+(is|below)\b|\byour\s+code\b",
    re.IGNORECASE,
)
_TOKEN = re.compile(r"(?<![A-Za-z0-9@./#:_-])([A-Za-z0-9]{4,12})(?![A-Za-z0-9@/_-])")
_YEAR = re.compile(r"^(19|20)\d\d$")
_STOPWORDS = frozenset(
    {
        "code", "codes", "field", "application", "security", "verification", "verify", "please",
        "enter", "paste", "below", "above", "email", "expires", "minutes", "thanks", "thank",
        "greenhouse", "submit", "your", "this", "that", "with", "into", "from",
    }
)


def _is_candidate(token: str) -> bool:
    if token.lower() in _STOPWORDS or _YEAR.match(token):
        return False
    has_digit = any(c.isdigit() for c in token)
    if has_digit:
        # Pure digits shorter than 4 or longer than 10 are rarely codes.
        return not token.isdigit() or 4 <= len(token) <= 10
    # Letters only: accept shouty codes like "QXTRWB", never ordinary words.
    return token.isupper() and 6 <= len(token) <= 10


def extract_code(subject: str | None, text: str | None) -> str | None:
    """The verification code in an email, or None when it does not carry one."""
    subject = subject or ""
    body = text or ""
    full = f"{subject}\n{body}"
    match = _KEYWORD.search(full)
    if not match:
        return None

    # A code on its own line is the most common layout ("...on your application:\n\n8TG4jLy3").
    for line in body.splitlines():
        line = line.strip().strip(".:")
        if _TOKEN.fullmatch(line) and _is_candidate(line):
            return line

    # Otherwise the first plausible token shortly after any keyword mention.
    for kw in _KEYWORD.finditer(full):
        window = full[kw.end(): kw.end() + 220]
        for tok in _TOKEN.finditer(window):
            if _is_candidate(tok.group(1)):
                return tok.group(1)
    return None


def _norm(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


_COMPANY_SUFFIXES = {"inc", "llc", "ltd", "corp", "corporation", "co", "company", "gmbh", "plc", "the", "group", "technologies", "labs"}


def company_terms(company: str | None) -> list[str]:
    words = [w for w in _norm(company).split() if w not in _COMPANY_SUFFIXES]
    if not words:
        return []
    terms = [" ".join(words)]
    if len(words[0]) >= 4:
        terms.append(words[0])
    return terms


def mentions_company(company: str | None, *texts: str | None) -> bool:
    terms = company_terms(company)
    if not terms:
        return False
    hay = " " + " ".join(_norm(t) for t in texts if t) + " "
    return any(f" {t} " in hay for t in terms)


async def find_code(
    grant_id: str,
    *,
    since: datetime,
    company: str | None = None,
    exclude: set[str] | None = None,
) -> dict[str, Any] | None:
    """Newest code-bearing message received after ``since`` (UTC).

    With a company, the message must mention it: parallel applications can be
    waiting on codes at the same time and must not swap them.
    """
    now = datetime.now(timezone.utc)
    if since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)
    after = max(since - SINCE_SLACK, now - MAX_LOOKBACK)
    exclude = exclude or set()

    headers = await nylas_service.list_messages(grant_id, received_after=after, max_messages=MAX_MESSAGES)
    fetched = 0
    for raw in headers:
        subject = str(raw.get("subject") or "")
        snippet = str(raw.get("snippet") or "")
        sender = nylas_service.sender_label(raw.get("from"))
        if not _KEYWORD.search(f"{subject}\n{snippet}"):
            continue
        code = extract_code(subject, snippet)
        body = ""
        if (not code or company) and fetched < MAX_BODY_FETCHES:
            fetched += 1
            try:
                full = await nylas_service.get_message(grant_id, str(raw["id"]))
                body = nylas_service.html_to_text(full.get("body"))
            except nylas_service.MailAuthError:
                raise
            except nylas_service.MailError as e:
                logger.info("verification_code_body_failed", error=str(e))
            code = extract_code(subject, body) or code
        if not code or code in exclude:
            continue
        if company and not mentions_company(company, subject, sender, snippet, body):
            continue
        received = nylas_service.message_datetime(raw)
        return {
            "code": code,
            "from": sender,
            "subject": subject,
            "received_at": received.replace(tzinfo=timezone.utc).isoformat() if received else None,
        }
    return None
