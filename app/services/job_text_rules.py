"""Deterministic salary, employment-type and work-mode phrase rules for raw JD text.

These run in ``build_metadata`` after ATS fields and labelled header lines, so
they only fill what the structured signals left empty. Every rule needs an
explicit textual signal; anything ambiguous returns None rather than a guess.
"""

from __future__ import annotations

import re

# ── Salary ────────────────────────────────────────────────────────────────

_CODES = "USD|CAD|AUD|NZD|SGD|HKD|EUR|GBP|CHF|INR|JPY|SEK|NOK|DKK|PLN|MXN|BRL"
_SYMBOL = r"(?:US\$|CA\$|C\$|A\$|AU\$|NZ\$|S\$|HK\$|[$£€₹¥])"
_NUM = r"\d{1,3}(?:[,.\u202f\u00a0 ]\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d+)?"
_DASH = r"\s*(?:-|\u2013|\u2014|\u2012|\u2212|~|to|and)\s*"
_NOT_MAGNITUDE = r"(?!\s?(?:[mMbB]\b|mm\b|bn\b|million|billion|trillion|%|\+?\s?(?:users|customers|employees)))"
_K = r"(?P<{name}>[kK]\b|\s?thousand\b)?"

_AMOUNT = (
    r"(?P<{c}>{sym})?\s?(?P<{n}>{num})" + _K + _NOT_MAGNITUDE
)


def _amount(prefix: str) -> str:
    return _AMOUNT.format(c=f"{prefix}c", n=f"{prefix}n", sym=_SYMBOL, num=_NUM, name=f"{prefix}k")


_PERIOD = (
    r"(?:\s*(?:/|per|a|an|each)\s*(?P<per>year|yr|annum|hour|hr|month|mo|week|wk|day)\b"
    r"|\s*(?P<per2>annually|yearly|per-year|hourly|monthly|weekly|daily)\b)?"
)
_RANGE_RE = re.compile(
    r"(?P<pre>\b(?:" + _CODES + r")\s?)?"
    + _amount("a")
    + _DASH
    + _amount("b")
    + r"(?:\s*(?P<code>" + _CODES + r")\b)?"
    + r"(?:\s*\((?:" + _CODES + r")\))?"
    + _PERIOD
    + r"(?:\s*(?P<ote>OTE)\b)?",
    re.IGNORECASE,
)
_SINGLE_RE = re.compile(
    r"(?P<lead>up to|starting at|begins at|starts at|from|at least|minimum of|of)?\s*"
    r"(?P<pre>\b(?:" + _CODES + r")\s?)?"
    + _amount("a")
    + r"(?P<plus>\+)?"
    + r"(?:\s*(?P<code>" + _CODES + r")\b)?"
    + _PERIOD
    + r"(?:\s*(?P<ote>OTE)\b)?",
    re.IGNORECASE,
)
_SALARY_CONTEXT_RE = re.compile(
    r"(?i)(?<![a-z])(?:salary|salaries|base pay|pay range|pay rate|pay band|compensation|"
    r"wage|ote|on-target earnings|total cash|annual base|base range|hourly rate|rate:)"
)
_NOT_SALARY_CONTEXT_RE = re.compile(
    r"(?i)\b(?:funding|raised|revenue|valuation|series [a-e]|stipend|budget|bonus|"
    r"reimburse|allowance|401\(?k\)?|equity|arr\b|investment|grant|sign-on|signing)"
)

_ANNUAL_RANGE = (15_000.0, 3_000_000.0)
_HOURLY_RANGE = (7.0, 600.0)
_MONTHLY_RANGE = (1_000.0, 60_000.0)


def _to_number(raw: str, k: str | None) -> float | None:
    text = raw.replace("\u202f", ",").replace("\u00a0", ",").replace(" ", ",")
    # "50.000" is European grouping, "50.5" a decimal.
    if re.fullmatch(r"\d{1,3}(?:\.\d{3})+", text):
        text = text.replace(".", "")
    text = text.replace(",", "")
    try:
        value = float(text)
    except ValueError:
        return None
    if k:
        value *= 1000.0
    return value


def _period(m: re.Match) -> str | None:
    raw = (m.group("per") or m.group("per2") or "").lower()
    if not raw:
        return None
    if raw.startswith(("hour", "hr")):
        return "hour"
    if raw.startswith(("month", "mo")):
        return "month"
    if raw.startswith(("week", "wk")):
        return "week"
    if raw.startswith(("day", "daily")):
        return "day"
    return "year"


def _plausible(lo: float, hi: float, period: str | None) -> str | None:
    """Return the resolved period when the amounts read like pay, else None."""
    if hi < lo or lo <= 0:
        return None
    if hi > lo * 4.0:
        return None
    candidates = [period] if period else ["year", "hour"]
    for per in candidates:
        bounds = {
            "year": _ANNUAL_RANGE,
            "hour": _HOURLY_RANGE,
            "month": _MONTHLY_RANGE,
            "week": (300.0, 15_000.0),
            "day": (60.0, 3_000.0),
        }.get(per or "year", _ANNUAL_RANGE)
        if bounds[0] <= lo and hi <= bounds[1]:
            return per
    return None


def _display(raw: str) -> str:
    return re.sub(r"\s+", " ", raw).strip()


def _fmt_amount(cur: str, num: str, k: str | None) -> str:
    return f"{cur}{num.strip()}{'K' if (k or '').strip().lower() in {'k', 'thousand'} else ''}"


def _window_has(regex: re.Pattern, text: str, start: int, end: int, before: int = 160, after: int = 60) -> bool:
    return bool(regex.search(text[max(0, start - before) : min(len(text), end + after)]))


def infer_salary_from_text(text: str | None) -> str | None:
    """Best pay range (or explicit single figure) stated in the posting, normalised for display."""
    if not text:
        return None
    body = text[:60_000]
    best: tuple[float, int, str] | None = None

    for m in _RANGE_RE.finditer(body):
        cur_a, cur_b = m.group("ac") or "", m.group("bc") or ""
        code = (m.group("code") or m.group("pre") or "").strip().upper()
        if not (cur_a or cur_b or code):
            continue
        lo = _to_number(m.group("an"), m.group("ak"))
        hi = _to_number(m.group("bn"), m.group("bk"))
        if lo is None or hi is None:
            continue
        lo_k = m.group("ak")
        # "$150-180K": the K on the upper bound covers both.
        if not lo_k and m.group("bk") and lo < 1000 <= hi:
            lo *= 1000.0
            lo_k = m.group("bk")
        stated = _period(m)
        period = _plausible(lo, hi, stated)
        if period is None:
            continue
        context = _window_has(_SALARY_CONTEXT_RE, body, m.start(), m.end())
        if stated is None and period != "year" and not context:
            continue
        noise = _window_has(_NOT_SALARY_CONTEXT_RE, body, m.start(), m.end(), before=60, after=30)
        if noise and not context:
            continue
        cur = cur_a or cur_b
        text_out = f"{_fmt_amount(cur, m.group('an'), lo_k)} - {_fmt_amount(cur_b or cur, m.group('bn'), m.group('bk'))}"
        if code:
            text_out += f" {code}"
        if period == "hour":
            text_out += " per hour"
        elif period in {"month", "week", "day"}:
            text_out += f" per {period}"
        if m.group("ote"):
            text_out += " OTE"
        score = (2.0 if context else 0.0) + (1.0 if (code or _period(m)) else 0.0)
        if best is None or score > best[0]:
            best = (score, m.start(), text_out)
        if score >= 3.0:
            break

    if best is not None:
        return best[2]

    for m in _SINGLE_RE.finditer(body):
        cur = m.group("ac") or ""
        code = (m.group("code") or m.group("pre") or "").strip().upper()
        if not (cur or code):
            continue
        if not _window_has(_SALARY_CONTEXT_RE, body, m.start(), m.end(), before=120, after=20):
            continue
        if _window_has(_NOT_SALARY_CONTEXT_RE, body, m.start(), m.end(), before=40, after=20):
            continue
        value = _to_number(m.group("an"), m.group("ak"))
        if value is None:
            continue
        period = _plausible(value, value, _period(m))
        if period is None:
            continue
        lead = (m.group("lead") or "").strip().lower()
        text_out = _fmt_amount(cur, m.group("an"), m.group("ak"))
        if m.group("plus"):
            text_out += "+"
        if lead == "up to":
            text_out = f"Up to {text_out}"
        elif lead in {"starting at", "begins at", "starts at", "from", "at least", "minimum of"}:
            text_out = f"From {text_out}"
        if code:
            text_out += f" {code}"
        if period == "hour":
            text_out += " per hour"
        elif period in {"month", "week", "day"}:
            text_out += f" per {period}"
        if m.group("ote"):
            text_out += " OTE"
        return text_out
    return None


# ── Employment type ───────────────────────────────────────────────────────

# Title markers must be delimited: "Contract Manager" is a legal role, not a contract.
_DELIM = r"(?:^|[(\[|/,\u2013\u2014-])\s*"
_DELIM_END = r"\s*(?:$|[)\]|/,\u2013\u2014(-])"
_TITLE_TYPE_RES: tuple[tuple[str, re.Pattern], ...] = (
    ("Internship", re.compile(r"(?i)\b(?:intern|internship|co-?op)\b")),
    (
        "Contract",
        re.compile(
            rf"(?i)(?:{_DELIM}(?:contract|contractor|freelance|temp to perm){_DELIM_END}"
            r"|\bcontract[- ]to[- ]hire\b|\bc2h\b|\b1099\b|\bw-?2 contract\b|\b\d{1,2}[- ]?months? contract\b)"
        ),
    ),
    ("Part-time", re.compile(r"(?i)\bpart[- ]?time\b")),
    ("Temporary", re.compile(rf"(?i)(?:\btemporary\b|\bseasonal\b|{_DELIM}temp{_DELIM_END})")),
)
_BODY_CONTRACT_RE = re.compile(
    r"(?i)\b(?:this is a (?:\d+[- ]month )?contract(?:or)? (?:role|position|opportunity|engagement)|"
    r"\d{1,2}[- ](?:to[- ]\d{1,2}[- ])?months? contract|contract[- ]to[- ]hire|corp[- ]to[- ]corp|\bc2c\b|"
    r"w-?2 contract|1099 contract|contract (?:role|position) (?:of|for) \d)"
)
_BODY_INTERN_RE = re.compile(
    r"(?i)\b(?:this (?:is a|internship) |summer |paid |\d{1,2}[- ](?:week|month) )internship\b"
)
_BODY_PART_TIME_RE = re.compile(
    r"(?i)\b(?:this is a part[- ]time|part[- ]time (?:role|position|job|opportunity|contract)|"
    r"\d{1,2}(?:\s*-\s*\d{1,2})? hours (?:per|a) week)\b"
)
_BODY_TEMP_RE = re.compile(
    r"(?i)(?:this|the) (?:role|position|job) is (?:a )?(?:temporary|fixed[- ]term)\b"
    r"|this is a (?:temporary|fixed[- ]term) (?:role|position|contract|assignment)\b"
)
_BODY_FULL_TIME_RE = re.compile(r"(?i)\b(?:full[- ]?time|permanent (?:role|position)|fte\b)")
_FULL_TIME_NOISE_RE = re.compile(r"(?i)\bfull[- ]?time (?:employees?|staff|team members?|workers?)\b")

_TYPE_ALIASES: tuple[tuple[str, re.Pattern], ...] = (
    ("Internship", re.compile(r"(?i)\b(?:intern|internship|co-?op)\b")),
    ("Contract", re.compile(r"(?i)\b(?:contract|contractor|freelance|1099|c2c|c2h)\b")),
    ("Part-time", re.compile(r"(?i)\bpart[\s_-]?time\b")),
    ("Temporary", re.compile(r"(?i)\b(?:temporary|temp|seasonal|fixed[\s_-]term)\b")),
    ("Full-time", re.compile(r"(?i)\b(?:full[\s_-]?time|permanent|regular|fte|full)\b")),
)


def normalize_employment_type(value: str | None) -> str | None:
    """Map ATS spellings (``FULL_TIME``, ``Fulltime``, ``Full``) onto one display form."""
    raw = (value or "").strip()
    if not raw:
        return None
    for label, regex in _TYPE_ALIASES:
        if regex.search(raw):
            return label
    return raw


def infer_employment_type(title: str | None, text: str | None) -> str | None:
    """Employment type from title markers first, then explicit body phrases."""
    if title:
        for label, regex in _TITLE_TYPE_RES:
            if regex.search(title):
                return label
    body = (text or "")[:40_000]
    if not body:
        return None
    if _BODY_CONTRACT_RE.search(body):
        return "Contract"
    if _BODY_INTERN_RE.search(body):
        return "Internship"
    if _BODY_PART_TIME_RE.search(body):
        return "Part-time"
    if _BODY_TEMP_RE.search(body):
        return "Temporary"
    hits = [m for m in _BODY_FULL_TIME_RE.finditer(body)]
    if any(not _FULL_TIME_NOISE_RE.match(body, m.start()) for m in hits):
        return "Full-time"
    return None


# ── Work-mode phrases ─────────────────────────────────────────────────────

_NUM_WORD = r"(?:\d|one|two|three|four|five)"
_NOT_RARE_VISIT = r"(?!\s*(?:per|a|each|every|/)\s*(?:quarter|month|year))"
# No leading \b: scraped pages often glue sentences together ("OtherThis role is remote").
_ROLE = r"(?<!if )(?<!when )(?:this|the|our) (?:role|position|job|opportunity)"
_NOT_REMOTE_RE = re.compile(
    r"(?i)(?:this is not a remote|not a remote (?:role|position|job)|"
    r"(?:role|position|job) is not (?:a )?remote|not eligible for remote|"
    r"remote work is not (?:available|possible|an option)|\bno remote (?:work|option)s?\b|\bnon-remote)"
)
_ROLE_SCOPED: tuple[tuple[str, re.Pattern], ...] = (
    ("hybrid", re.compile(rf"(?i){_ROLE} (?:is|will be) (?:a )?hybrid\b")),
    ("onsite", re.compile(
        rf"(?i){_ROLE} is (?:based )?(?:fully |100% )?(?:on-?site|in[- ](?:the )?office|in[- ]person)\b"
    )),
    ("remote", re.compile(rf"(?i){_ROLE} (?:is|can be|will be) (?:a )?(?:fully |100% )?remote\b")),
)
_DAYS_IN_OFFICE_RES = (
    re.compile(
        rf"(?i)\b{_NUM_WORD}(?:\s*(?:-|to|or)\s*{_NUM_WORD})?\+?\s*(?:days?|x)\s*(?:a|per|each|/)?\s*"
        rf"(?:week|wk)?\s*(?:in|at|from|on)[- ](?:the |our |an |a |one of our )?(?:[\w.&'-]+ ){{0,3}}?"
        rf"(?:office|offices|hq|headquarters|site|on-?site|studio|campus)\b"
        + _NOT_RARE_VISIT
    ),
    re.compile(
        rf"(?i)\b(?:in|at)[- ](?:the |our )?(?:office|hq|headquarters|on-?site)\s*(?:at least |a minimum of |about )?"
        rf"{_NUM_WORD}(?:\s*(?:-|to|or)\s*{_NUM_WORD})?\s*days?\s*(?:a|per|each|/)\s*week"
    ),
)
_ONSITE_STRONG_RE = re.compile(
    r"(?i)\b(?:fully|100%|five days a week|5 days a week|full[- ]time) (?:on-?site|in[- ](?:the )?office|in[- ]person)\b"
    r"|\b(?:on-?site|in[- ]office|in[- ]person) (?:role|position)\b"
)
# Culture copy ("our hybrid work model", "hybrid work, AI adoption") is not about the role.
_HYBRID_WEAK_RE = re.compile(
    r"(?i)\b(?:hybrid (?:role|position)(?!\s*[-\u2013\u2014,:]?\s*(?:part|spanning|combining|that combines|blending|between|across|of)\b)|"
    r"hybrid (?:schedule|opportunity)|"
    r"(?:work mode|workplace type|workplace|location[^:\n]{0,20}):\s*hybrid|\(hybrid\))"
)
_REMOTE_WEAK_RE = re.compile(
    r"(?i)\b(?:fully|100%|completely|entirely|100 percent) remote\b"
    r"|\b(?:remote[- ](?:first|only)|work from anywhere|remote (?:role|position|opportunity))\b"
)


def classify_work_mode_phrases(text: str | None) -> tuple[str | None, bool]:
    """(mode, strong) from explicit work-arrangement phrases.

    ``strong`` phrases speak about this role ("this role is remote", "3 days a
    week in the office", "not a remote role") and outrank a location label;
    weak ones ("our hybrid work model", "remote-first") only fill gaps.
    """
    body = (text or "")[:40_000]
    if not body:
        return None, False
    if _NOT_REMOTE_RE.search(body):
        return "onsite", True
    for mode, regex in _ROLE_SCOPED:
        if regex.search(body):
            return mode, True
    if any(r.search(body) for r in _DAYS_IN_OFFICE_RES):
        return "hybrid", True
    if _ONSITE_STRONG_RE.search(body):
        return "onsite", True
    if _HYBRID_WEAK_RE.search(body):
        return "hybrid", False
    if _REMOTE_WEAK_RE.search(body):
        return "remote", False
    return None, False
