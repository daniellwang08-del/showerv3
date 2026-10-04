"""Deterministic role family, specialty and seniority from job titles.

Embedding similarity rewards titles that share words ("Sales Engineer" and
"Backend Engineer" sit close together), so it cannot tell a different job
function from a near neighbour. These keyword rules give the match scorer the
function a recruiter would read off a title first:

* family: the broad job function (software, data, sales, finance, ...)
* specialty: the area inside technical, marketing or sales work (backend, ml,
  product marketing, partnerships, ...)
* level: seniority on a 0 (intern) to 5 (VP / C-level) scale

Affinities between families and specialties are hand-set from how readily a
recruiter would accept experience in one as evidence for the other. They were
validated against reference judgements, not fitted to them.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable

# First match wins, so specific functions come before the generic ones they
# contain ("Engineering Manager" before "Engineer", "Sales Engineer" before
# "Engineer", "Finance Manager, Platform" before "Platform").
_FAMILY_PATTERNS: tuple[tuple[str, str], ...] = (
    ("product", r"^product(?: at\b|,|$)"),
    ("design", r"^product design$|\bproduct design(?:er)?\b"),
    ("solutions", r"\b(?:account|field|customer) cto\b"),
    ("program", r"\b(?:technical )?program manag\w*|\btpm\b"),
    ("tech_support", r"\b(?:technical support|support engineer\w*|cloud support|production support)"),
    (
        "eng_management",
        r"\b(?:engineering manager|manager,? (?:software )?engineering|director,? (?:of )?(?:software )?engineering|"
        r"vp,? (?:of )?engineering|head of (?:software )?engineering|cto\b|chief technology)",
    ),
    (
        "solutions",
        r"\b(?:sales engineer|solutions? (?:engineer|engineering|architect|consult\w*|specialist)|solution consulting|"
        r"pre-?sales|customer engineer|field engineer|implementation (?:engineer|consultant|specialist|manager)|"
        r"technical account manager)",
    ),
    (
        "hardware",
        r"\b(?:design engineer|hardware|mechanical|electrical engineer|asic|fpga|rf engineer|"
        r"manufacturing engineer|process engineer|civil engineer|chemical engineer)",
    ),
    ("security", r"\b(?:security|appsec|infosec|cyber|soc analyst|penetration)"),
    (
        "data",
        r"\b(?:data scien\w*|machine learning|ml engineer|ai engineer|ai researcher|research scientist|data engineer\w*|"
        r"analytics engineer\w*|data analyst|business intelligence|bi analyst|data platform|analytics|applied scientist|statistician)",
    ),
    ("design", r"\b(?:designer|design lead|ux\b|ui/ux|user experience|creative director|illustrator|art director)"),
    (
        "product",
        r"\b(?:product manager|product owner|product lead|head of product|vp,? product|director,? product|"
        r"group product|product operations)",
    ),
    (
        "software",
        r"\b(?:software|engineer\w*|developer|programmer|swe\b|sre\b|devops|architect|member of technical staff|mts\b|"
        r"full ?stack|backend|back end|front ?end|platform|infrastructure|qa\b|test automation|mobile|ios\b|android|firmware|embedded)",
    ),
    (
        "sales",
        r"\b(?:accounts? executive|sales|business development|bdr\b|sdr\b|account manager|partnerships?|partner manager|"
        r"channel|revenue|relationship manager|commercial)",
    ),
    (
        "marketing",
        r"\b(?:marketing|growth|content|brand|copywriter|seo\b|communications|public relations|pr manager|social media|"
        r"video|editor|writer|demand gen|community)",
    ),
    (
        "customer",
        r"\b(?:customer success|customer support|support|escalation|customer experience|client success|onboarding|"
        r"service desk|help ?desk)",
    ),
    (
        "finance",
        r"\b(?:finance|financial|accountant|accounting|payroll|tax\b|controller|fp&a|treasury|audit|bookkeep\w*|billing)",
    ),
    (
        "people",
        r"\b(?:recruit\w*|talent|human resources|hr\b|people (?:ops|operations|partner|business partner)|hrbp|"
        r"benefits|compensation)",
    ),
    ("legal", r"\b(?:counsel|legal|attorney|lawyer|paralegal|compliance|privacy|regulatory)"),
    (
        "operations",
        r"\b(?:operations|ops\b|chief of staff|project manager|project management|office manager|"
        r"administrator|coordinator|enablement|readiness|strategy)",
    ),
)
_FAMILY_RE = tuple((name, re.compile(pattern, re.I)) for name, pattern in _FAMILY_PATTERNS)

TECHNICAL_FAMILIES = frozenset({"software", "data", "security", "eng_management", "solutions", "hardware"})

# Symmetric; anything unlisted between two known families scores _UNRELATED.
_FAMILY_AFFINITY: dict[frozenset[str], float] = {
    frozenset({"software", "data"}): 0.7,
    frozenset({"software", "security"}): 0.6,
    frozenset({"software", "eng_management"}): 0.6,
    frozenset({"software", "solutions"}): 0.5,
    frozenset({"software", "product"}): 0.3,
    frozenset({"software", "hardware"}): 0.3,
    frozenset({"software", "design"}): 0.15,
    frozenset({"data", "eng_management"}): 0.5,
    frozenset({"data", "security"}): 0.35,
    frozenset({"data", "solutions"}): 0.45,
    frozenset({"data", "product"}): 0.35,
    frozenset({"data", "hardware"}): 0.15,
    frozenset({"security", "eng_management"}): 0.45,
    frozenset({"security", "solutions"}): 0.4,
    frozenset({"eng_management", "product"}): 0.45,
    frozenset({"eng_management", "solutions"}): 0.4,
    frozenset({"solutions", "product"}): 0.35,
    frozenset({"solutions", "sales"}): 0.4,
    frozenset({"solutions", "customer"}): 0.4,
    frozenset({"design", "product"}): 0.4,
    frozenset({"design", "marketing"}): 0.4,
    frozenset({"sales", "customer"}): 0.5,
    frozenset({"sales", "marketing"}): 0.4,
    frozenset({"marketing", "product"}): 0.3,
    frozenset({"operations", "customer"}): 0.35,
    frozenset({"operations", "finance"}): 0.3,
    frozenset({"operations", "people"}): 0.3,
    frozenset({"operations", "sales"}): 0.3,
    frozenset({"finance", "legal"}): 0.25,
    frozenset({"program", "product"}): 0.4,
    frozenset({"program", "eng_management"}): 0.45,
    frozenset({"program", "operations"}): 0.5,
    frozenset({"program", "software"}): 0.3,
    frozenset({"program", "data"}): 0.2,
    frozenset({"tech_support", "software"}): 0.35,
    frozenset({"tech_support", "customer"}): 0.4,
    frozenset({"tech_support", "solutions"}): 0.5,
    frozenset({"tech_support", "security"}): 0.25,
}
_UNRELATED = 0.1
# A title the rules cannot place is weak evidence either way.
_UNKNOWN_FAMILY = 0.35

_SPECIALTY_PATTERNS: tuple[tuple[str, str], ...] = (
    (
        "hardware",
        r"\b(?:design engineer|hardware|mechanical|electrical|firmware|embedded|asic|fpga|rf engineer|"
        r"manufactur\w*|process engineer|civil|chemical)",
    ),
    ("security", r"\b(?:security|appsec|infosec|cyber|compliance|penetration|soc analyst)"),
    ("it", r"(?:\bit\b|\bit engineer|systems administrator|help ?desk|desktop support|it architect|it support)"),
    ("mobile", r"\b(?:mobile|ios\b|android|react native|flutter)"),
    ("qa", r"\b(?:qa\b|quality|test\w*|sdet)"),
    ("data_science", r"\b(?:data scien\w*|statistic\w*|quantitative|decision scien\w*)"),
    ("analytics", r"\b(?:analyst|business intelligence|bi\b|insights|reporting|dashboards?)"),
    (
        "ml",
        r"\b(?:machine learning|ml\b|ai\b|a\.i\.|research engineer|research scientist|reinforcement|nlp\b|"
        r"computer vision|llms?\b|deep learning|applied scien\w*|inference|genai)",
    ),
    (
        "data_eng",
        r"\b(?:data engineer\w*|data platform|analytics engineer\w*|data infrastructure|etl\b|data ingestion|"
        r"data pipelines?|data warehous\w*)",
    ),
    ("frontend", r"\b(?:front ?end|ui engineer|web developer|web engineer)"),
    ("fullstack", r"\b(?:full ?stack)"),
    (
        "platform",
        r"\b(?:platform|infrastructure|devops|sre\b|site reliability|cloud|reliability|build|release|"
        r"developer productivity|kubernetes|dataplane|systems engineer)",
    ),
    ("backend", r"\b(?:back ?end|apis?\b|server|distributed|payments?|billing)"),
)
_SPECIALTY_RE = tuple((name, re.compile(pattern, re.I)) for name, pattern in _SPECIALTY_PATTERNS)

# Specialties inside non-technical families, read from titles only: their
# keywords ("growth", "channel") mean something else in engineering text.
_FAMILY_SPECIALTY_PATTERNS: dict[str, tuple[tuple[str, str], ...]] = {
    "marketing": (
        ("product_marketing", r"\b(?:product marketing|pmm\b)"),
        ("customer_marketing", r"\bcustomer (?:marketing|advocacy)|\badvocacy\b"),
        ("field_marketing", r"\b(?:field marketing|events?\b|partner marketing|channel marketing)"),
        (
            "growth_marketing",
            r"\b(?:growth|demand gen\w*|performance marketing|paid|acquisition|lifecycle|crm\b|email|campaigns?|"
            r"marketing op\w*)",
        ),
        (
            "content_marketing",
            r"\b(?:content|brand|copywriter|communications|public relations|pr\b|social media|video|editor|writer|"
            r"community|creative)",
        ),
    ),
    "sales": (
        ("sdr", r"\b(?:sdr|bdr|sales development|business development rep\w*|lead development)"),
        ("partnerships", r"\b(?:partnerships?|partner manager|alliances?|channel|business development)"),
        ("account_management", r"\b(?:account manager|account management|relationship manager|renewals?)"),
        (
            "account_executive",
            r"\b(?:accounts? executive|sales executive|account director|sales director|sales manager|seller|"
            r"sales rep\w*)",
        ),
    ),
}
_FAMILY_SPECIALTY_RE = {
    family: tuple((name, re.compile(pattern, re.I)) for name, pattern in patterns)
    for family, patterns in _FAMILY_SPECIALTY_PATTERNS.items()
}
SPECIALTY_FAMILIES = TECHNICAL_FAMILIES | frozenset(_FAMILY_SPECIALTY_PATTERNS)

# Skill-lexicon category -> the specialty it is evidence for.
_CATEGORY_SPECIALTY = {
    "mobile": "mobile",
    "frontend": "frontend",
    "ml": "ml",
    "data": "data_eng",
    "security": "security",
    "devops": "platform",
    "cloud": "platform",
    "backend": "backend",
    "testing": "qa",
}

_SPECIALTY_AFFINITY: dict[frozenset[str], float] = {
    frozenset({"backend", "platform"}): 0.8,
    frozenset({"backend", "fullstack"}): 0.75,
    frozenset({"backend", "data_eng"}): 0.7,
    frozenset({"backend", "frontend"}): 0.4,
    frozenset({"backend", "ml"}): 0.45,
    frozenset({"backend", "qa"}): 0.5,
    frozenset({"backend", "security"}): 0.35,
    frozenset({"backend", "data_science"}): 0.3,
    frozenset({"platform", "data_eng"}): 0.65,
    frozenset({"platform", "ml"}): 0.5,
    frozenset({"platform", "qa"}): 0.5,
    frozenset({"platform", "security"}): 0.4,
    frozenset({"platform", "it"}): 0.4,
    frozenset({"platform", "fullstack"}): 0.55,
    frozenset({"platform", "data_science"}): 0.3,
    frozenset({"fullstack", "frontend"}): 0.75,
    frozenset({"fullstack", "data_eng"}): 0.5,
    frozenset({"fullstack", "mobile"}): 0.45,
    frozenset({"frontend", "mobile"}): 0.5,
    frozenset({"ml", "data_eng"}): 0.7,
    frozenset({"ml", "data_science"}): 0.7,
    frozenset({"data_eng", "data_science"}): 0.5,
    frozenset({"analytics", "data_science"}): 0.55,
    frozenset({"analytics", "data_eng"}): 0.45,
    frozenset({"analytics", "ml"}): 0.25,
    frozenset({"growth_marketing", "customer_marketing"}): 0.55,
    frozenset({"growth_marketing", "field_marketing"}): 0.55,
    frozenset({"growth_marketing", "product_marketing"}): 0.45,
    frozenset({"growth_marketing", "content_marketing"}): 0.45,
    frozenset({"product_marketing", "customer_marketing"}): 0.55,
    frozenset({"product_marketing", "content_marketing"}): 0.5,
    frozenset({"product_marketing", "field_marketing"}): 0.45,
    frozenset({"content_marketing", "customer_marketing"}): 0.45,
    frozenset({"content_marketing", "field_marketing"}): 0.4,
    frozenset({"field_marketing", "customer_marketing"}): 0.45,
    frozenset({"account_executive", "account_management"}): 0.6,
    frozenset({"account_executive", "sdr"}): 0.6,
    frozenset({"account_executive", "partnerships"}): 0.45,
    frozenset({"account_management", "partnerships"}): 0.45,
    frozenset({"account_management", "sdr"}): 0.35,
    frozenset({"sdr", "partnerships"}): 0.3,
}
_SPECIALTY_UNRELATED = 0.2
# What a plain "Software Engineer" title usually covers.
_GENERIC_SOFTWARE_SPECIALTIES = {"backend": 0.6, "fullstack": 0.6, "platform": 0.4, "frontend": 0.3}
# A generic title ("Software Engineer") or a profile with no specialty signal.
_SPECIALTY_GENERAL = 0.85
# Listed skills show exposure to a specialty, not that the candidate worked in
# it ("SQL" on an analyst profile is not data engineering).
_INDIRECT_EVIDENCE_CAP = 0.5

_LEVEL_PATTERNS: tuple[tuple[float, str], ...] = (
    (0.0, r"\b(?:intern|internship|co-?op|apprentice|student)\b"),
    (1.0, r"\b(?:junior|jr\.?|entry[- ]level|graduate|new grad|associate)\b"),
    (5.0, r"\b(?:vp|rvp|avp|svp|evp|vice president|head of|chief|cto|ceo|cfo)\b"),
    (4.0, r"\b(?:director|principal|distinguished|fellow)\b"),
    (3.0, r"\b(?:staff(?! accountant)|lead|manager|architect|group)\b(?<!technical staff)"),
    (2.0, r"\b(?:senior|sr\.?|ii|iii|iv)\b"),
)
_LEVEL_RE = tuple((value, re.compile(pattern, re.I)) for value, pattern in _LEVEL_PATTERNS)
# "Manager" in these titles names the job, not a people manager.
_IC_MANAGER_RE = re.compile(
    r"\b(?:product|program|project|account|marketing|campaign|success|partner|partnerships|community|content|"
    r"brand|social media|relationship|territory|office|case|category|growth|lifecycle|channel|"
    r"implementation|delivery|solution delivery|release|vendor|events?)\s+manager\b",
    re.I,
)
MID_LEVEL = 1.5

_SEGMENT_RE = re.compile(r"\s*[,(|:/\u2013\u2014]\s*|\s+-\s*|-\s+")


def _first_family(text: str) -> str:
    for name, rx in _FAMILY_RE:
        if rx.search(text):
            return name
    return "other"


def role_family(title: str | None) -> str:
    """Job function of a title. The head segment decides ("Finance Manager, Platform")."""
    text = (title or "").strip()
    if not text:
        return "other"
    head = _SEGMENT_RE.split(text, maxsplit=1)[0]
    family = _first_family(head)
    return family if family != "other" else _first_family(text)


def role_specialty(title: str | None) -> str:
    text = title or ""
    patterns = _FAMILY_SPECIALTY_RE.get(role_family(text), _SPECIALTY_RE)
    for name, rx in patterns:
        if rx.search(text):
            return name
    return "general"


def role_level(title: str | None, default: float | None = MID_LEVEL) -> float | None:
    """Seniority stated by a title; ``default`` when the title states none."""
    text = (title or "").strip()
    if not text:
        return None
    text = _IC_MANAGER_RE.sub(lambda m: m.group(0).rsplit(" ", 1)[0], text)
    for value, rx in _LEVEL_RE:
        if rx.search(text):
            return value
    return default


def level_from_years(years: float | None) -> float | None:
    """Seniority a recruiter would assume from total years of experience alone."""
    if years is None:
        return None
    if years < 1:
        return 0.0
    if years < 3:
        return 1.0
    if years < 5:
        return MID_LEVEL
    if years < 9:
        return 2.0
    return 3.0


def family_affinity(job_family: str, user_families: Iterable[str]) -> float:
    """How well the candidate's recent functions evidence the job's function (0-1)."""
    families = list(user_families)
    if not families:
        return 0.5
    best = 0.0
    for idx, family in enumerate(families):
        recency = 1.0 if idx < 2 else 0.85
        if family == job_family:
            value = 1.0
        elif "other" in (family, job_family):
            value = _UNKNOWN_FAMILY
        else:
            value = _FAMILY_AFFINITY.get(frozenset({family, job_family}), _UNRELATED)
        best = max(best, value * recency)
    return best


def user_specialties(
    titles: Iterable[str],
    skills: dict[str, float] | None,
    skill_category: Callable[[str], str],
    experience_text: str = "",
) -> dict[str, float]:
    """Specialty -> strength (0-1) from recent titles, skill categories and role descriptions."""
    strengths: dict[str, float] = {}

    def bump(name: str, value: float) -> None:
        strengths[name] = max(strengths.get(name, 0.0), value)

    for idx, title in enumerate(list(titles)[:3]):
        name = role_specialty(title)
        if name != "general":
            bump(name, 1.0 if idx < 2 else 0.8)
        elif role_family(title) == "software":
            for generic, value in _GENERIC_SOFTWARE_SPECIALTIES.items():
                bump(generic, value)

    weight_by_specialty: dict[str, float] = {}
    for skill, weight in (skills or {}).items():
        name = _CATEGORY_SPECIALTY.get(skill_category(skill))
        if name:
            weight_by_specialty[name] = weight_by_specialty.get(name, 0.0) + float(weight)
    for name, total in weight_by_specialty.items():
        bump(name, min(_INDIRECT_EVIDENCE_CAP, total / 6.0))

    if experience_text:
        for name, rx in _SPECIALTY_RE:
            hits = len(rx.findall(experience_text))
            if hits:
                bump(name, min(0.85, hits / 4.0))
    return strengths


def specialty_affinity(job_specialty: str, user_strengths: dict[str, float]) -> float:
    if job_specialty == "general" or not user_strengths:
        return _SPECIALTY_GENERAL
    best = 0.0
    for name, strength in user_strengths.items():
        value = 1.0 if name == job_specialty else _SPECIALTY_AFFINITY.get(
            frozenset({name, job_specialty}), _SPECIALTY_UNRELATED
        )
        best = max(best, value * (0.5 + 0.5 * strength))
    return best
