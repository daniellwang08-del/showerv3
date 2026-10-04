"""Keyword industry profile of a posting or a candidate's work history.

Sentence embeddings place "card issuing APIs" and "EHR data APIs" close
together because both are API product work, so they cannot say whether the
candidate knows the employer's market. Counting market vocabulary can.
"""

from __future__ import annotations

import re

_INDUSTRY_PATTERNS: dict[str, str] = {
    "fintech": (
        r"\b(?:fintech|payments?|banking|banks?|card issuing|cards? programs?|lending|loans?|neobank|brokerage|"
        r"trading|wealth management|financial services|invoic\w*|expense management|accounts payable|"
        r"remittances?|money movement|ledgers?)\b"
    ),
    "insurance": r"\b(?:insurance|insurer|insurtech|underwrit\w*|policyholders?|actuarial)\b",
    "healthcare": (
        r"\b(?:health ?care|healthtech|health tech|clinical|clinicians?|patients?|hospitals?|ehr|emr|medical|"
        r"hipaa|telehealth|pharmacy|care delivery|payers?|health plans?|physicians?)\b"
    ),
    "life_sciences": (
        r"\b(?:biotech\w*|pharmaceutical|pharma|life sciences|drug discovery|genomic\w*|clinical trials?|"
        r"biolog\w*|laborator(?:y|ies))\b"
    ),
    "security": (
        r"\b(?:cybersecurity|cyber security|threat\w*|identity security|identity and access|zero trust|"
        r"vulnerabilit\w*|siem|endpoint|malware|secrets? detection|security operations)\b"
    ),
    "devtools": (
        r"\b(?:developer tools?|developer platform|developer experience|devops|observability|ci/cd|open source|"
        r"source code|repositor(?:y|ies)|kubernetes|cloud infrastructure|infrastructure software|databases?|"
        r"apis? platform|sdks?)\b"
    ),
    "commerce": (
        r"\b(?:e-?commerce|retail\w*|merchants?|shoppers?|checkout|online stores?|marketplaces?|consumer goods|"
        r"cpg|brands? and retailers)\b"
    ),
    "advertising": (
        r"\b(?:advertis\w*|adtech|ad tech|ads|ad platform|programmatic|marketing automation|martech|"
        r"attribution|demand generation)\b"
    ),
    "education": r"\b(?:edtech|education\w*|students?|learners?|teachers?|k-12|curricul\w*|courses?)\b",
    "media_gaming": (
        r"\b(?:gaming|video games?|game studio|players|streaming|entertainment|music|publishers?|creators?|"
        r"podcasts?|news)\b"
    ),
    "mobility_logistics": (
        r"\b(?:logistics|supply chain|freight|shipping|fleets?|transportation|mobility|automotive|vehicles?|"
        r"warehous\w*|last[- ]mile)\b"
    ),
    "real_estate": r"\b(?:real estate|proptech|mortgages?|homeowners?|home ?buyers?|property management|rentals?)\b",
    "public_sector": r"\b(?:government|public sector|federal|defen[cs]e|military|national security|agencies)\b",
    "energy_climate": (
        r"\b(?:energy|climate|solar|batter(?:y|ies)|power grid|utilities|carbon|decarboni\w*|"
        r"electric vehicles?|renewables?)\b"
    ),
    "hr_tech": (
        r"\b(?:payroll|workforce management|hris|human capital|recruiting software|applicant tracking|"
        r"employee benefits)\b"
    ),
    "crypto": r"\b(?:crypto\w*|blockchain|web3|defi|bitcoin|ethereum|stablecoins?|tokens?)\b",
    "travel_food": (
        r"\b(?:travel|hospitality|hotels?|airlines?|restaurants?|food delivery|grocer\w*|bookings?|"
        r"vacation)\b"
    ),
    "telecom": r"\b(?:telecom\w*|wireless|5g|network operators?|carriers?|contact cent(?:er|re)s?)\b",
}
_INDUSTRY_RE = {name: re.compile(pattern, re.I) for name, pattern in _INDUSTRY_PATTERNS.items()}
# Below this many keyword hits a text says nothing reliable about its market.
_MIN_HITS = 2


def industry_profile(text: str | None, *, min_hits: int = _MIN_HITS) -> dict[str, float]:
    """Industry -> share of market keywords (shares sum to 1; empty when unknown)."""
    if not text:
        return {}
    counts = {name: len(rx.findall(text)) for name, rx in _INDUSTRY_RE.items()}
    counts = {name: n for name, n in counts.items() if n >= min_hits}
    total = sum(counts.values())
    if not total:
        return {}
    return {name: round(n / total, 3) for name, n in counts.items()}


def industry_overlap(job: dict[str, float] | None, user: dict[str, float] | None) -> float | None:
    """Share of the job's market vocabulary the candidate's history shares (0-1); None if unknown."""
    if not job or not user:
        return None
    return sum(min(share, user.get(name, 0.0)) for name, share in job.items())
