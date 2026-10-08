"""The posting's skills a tailored resume must carry.

ATS ranking and recruiter search are literal: a required skill the candidate has but
the resume never names costs the match. This module reads the skills a posting asks
for (curated lexicon plus explicit lists such as "Hudi, Iceberg, or Delta"), ranks
them by the section they appear in, and checks each against the candidate's own
profile so tailoring can name every supported one and never invent the rest.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.core.logging import get_logger
from app.services.skill_lexicon import (
    PREFERRED_HEADING_RE,
    REQUIRED_HEADING_RE,
    SKILLS,
    _lookup_table,
)
from app.utils.company_name import companies_match
from app.utils.resume_evidence import (
    _ALIAS_GROUPS,
    _EXPANSIONS,
    _norm,
    is_mentioned,
    is_named_technology,
    parse_profile_roles,
    parse_profile_skills,
    role_evidence_texts,
    split_skill_items,
)

logger = get_logger(__name__)

REQUIRED = "required"
PREFERRED = "preferred"
CORE = "core"
MENTIONED = "mentioned"
_RANK = {REQUIRED: 0, PREFERRED: 1, CORE: 2, MENTIONED: 3}

_EXTRA_PREFERRED_RE = re.compile(r"\b(desired|bonus|nice to have|preferred|a plus)\b", re.IGNORECASE)
_CORE_HEADING_RE = re.compile(
    r"^(responsibilities|key responsibilities|what you(?:'|\u2019)?ll do|what you will do|in this role|"
    r"the role|about the (?:job|role|position|team|opportunity)|your impact|day to day|the job|"
    r"role overview|job description|overview|title:)",
    re.IGNORECASE,
)
_BOILERPLATE_HEADING_RE = re.compile(
    r"^(who we are|about (?:us|the company)|our (?:mission|values|culture|story|benefits)|benefits|perks|"
    r"compensation|pay|salary|equal (?:employment )?opportunity|eeo|diversity|why (?:join|work)|"
    r"what we offer|location|travel|hiring and how we work|stay alert|life at|see yourself|"
    r"accommodations?|privacy|disclaimer|how to apply|application process)",
    re.IGNORECASE,
)

# Lexicon single words that are also everyday English; they count only when capitalised mid-sentence.
_ENGLISH_HOMONYMS = frozenset(
    {
        "excel", "rest", "spring", "express", "chef", "puppet", "vault", "temporal", "remix", "astro",
        "phoenix", "ember", "electron", "oracle", "lambda", "unity", "ionic", "swift", "rust", "node",
        "apache", "gaming", "consulting", "hiring", "tax", "compensation", "litigation", "documentation",
        "delta", "iceberg",
    }
)
# Lexicon categories that read wrong on a resume for the skill ("Kafka" is streaming data, not DevOps).
_CATEGORY_OVERRIDES = {"kafka": "data", "rabbitmq": "backend", "nats": "backend"}
# Most required skills a posting can add to a profile that never names them.
_MAX_ADDED_SKILLS = 12
# Lexicon aliases too generic to list as a skill on their own.
_GENERIC_SURFACES = frozenset(
    {
        "optimization", "cache", "async", "monitoring", "alerting", "containers", "compliance", "payments",
        "banking", "dashboards", "troubleshooting", "profiling", "scalability", "algorithms", "crawling",
        "spreadsheets", "mentoring", "mentorship", "negotiation", "budgeting", "renewals", "calibration",
        "attribution", "prospecting", "copywriting", "typography", "newsletters", "risk management",
        "data analysis", "data extraction", "data pipelines", "data pipeline", "client facing", "crm",
        "e-commerce", "ecommerce", "banking", "financial services", "on-prem", "on-premise", "high availability",
        "pull requests", "version control", "technical writing", "remote", "virtualization", "firewalls",
    }
)
# Categories whose skills belong in a resume's technical skills section.
_TECH_CATEGORIES = frozenset(
    {"language", "frontend", "backend", "mobile", "database", "cloud", "devops", "data", "ml", "testing",
     "security", "tools", "practice", "architecture", "design"}
)
_SECTION_NAMES: dict[str, tuple[str, ...]] = {
    "language": ("Languages",),
    "frontend": ("Frontend",),
    "backend": ("Backend",),
    "mobile": ("Mobile",),
    "database": ("Databases", "Data"),
    "cloud": ("Cloud",),
    "devops": ("DevOps", "Cloud", "Observability", "Infrastructure"),
    "data": ("Data Engineering", "Data", "Analytics", "Data Science"),
    "ml": ("Machine Learning", "AI", "LLMs", "MLOps"),
    "testing": ("Testing",),
    "security": ("Security",),
    "tools": ("Tools", "DevOps"),
    "practice": ("Architecture", "Backend", "Engineering"),
    "architecture": ("Architecture", "Backend"),
    "design": ("Design",),
}
_NEW_SECTION = {
    "language": "Languages", "frontend": "Frontend", "backend": "Backend", "mobile": "Mobile",
    "database": "Databases", "cloud": "Cloud", "devops": "DevOps", "data": "Data Engineering",
    "ml": "Machine Learning", "testing": "Testing", "security": "Security", "tools": "Tools",
    "practice": "Architecture", "architecture": "Architecture", "design": "Design",
}

# Acronyms that are not skills (places, HR terms, levels).
_ACRONYM_STOP = frozenset(
    """
    US USA UK EU EMEA APAC LATAM NA CA WA NY NJ PA CT TX FL IL MA CO HI MD MN VT DC OR AZ GA NC VA OH MI
    AL AK AR DE IA IN KS KY LA ME MO MS MT ND NE NH NM NV RI SC SD TN UT WI WV WY
    EEO EEOC DEI PTO HQ CEO CTO CFO COO CPO VP SVP EVP II III IV OTE LLC INC FAQ ASAP FTE TBD USD OSS
    CAD EUR GBP HR IT PR MBA BS BA MS MSC PHD ID OK AM PM ET PT CT MT FYI ADA OFCCP LGBTQ DOE BSC
    """.split()
)
_LIST_CUE_RE = re.compile(
    r"(?:\bsuch as\b|\bincluding\b|\blike\b|\be\.g\.?|\bfor example\b|\bwith\b|\busing\b|\()\s*:?\s*",
    re.IGNORECASE,
)
_LIST_ITEM_RE = re.compile(r"^[A-Z][A-Za-z0-9.+#/-]*(?:\s+[A-Z0-9][A-Za-z0-9.+#/-]*){0,2}$")
_TOKEN_RE = re.compile(r"[A-Za-z0-9+#.\-/]+")
_PERCENTILE_RE = re.compile(r"[Pp]\d{2,3}(?:\.\d+)?")
# "Department: Engineering", "- Remote policy: remote": posting metadata, not requirements.
_METADATA_LINE_RE = re.compile(
    r"^(?:[-*\u2022]\s*)?(?:department|office|offices|remote policy|workplace(?: type)?|work mode|employment type|"
    r"job type|job id|req(?:uisition)? id|team|reports to|schedule|shift|travel|start date|posted|category|"
    r"seniority|level|salary|pay range|compensation|work authorization|visa sponsorship|clearance)\s*:\s",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class JobSkill:
    term: str
    importance: str
    canonical: str | None = None


@dataclass
class RequiredSkill:
    term: str
    importance: str
    roles: list[str] = field(default_factory=list)
    injectable: bool = True
    category: str | None = None
    # The profile never names it: the posting requires it, so it is added to the role whose work fits it best.
    added: bool = False


@dataclass
class SkillPlan:
    supported: list[RequiredSkill] = field(default_factory=list)
    related: list[tuple[str, str]] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    posting_terms: list[str] = field(default_factory=list)
    has_required_section: bool = False

    @property
    def supported_terms(self) -> list[str]:
        return [s.term for s in self.supported]

    @property
    def added(self) -> list[RequiredSkill]:
        return [s for s in self.supported if s.added]

    def must_name_in_roles(self) -> list[RequiredSkill]:
        """Skills a role must name in a bullet: required ones (core too when the posting lists no requirements), and every added one."""
        wanted = {REQUIRED} if self.has_required_section else {REQUIRED, CORE}
        return [s for s in self.supported if s.roles and (s.added or (s.importance in wanted and s.injectable))]

    def evidence_addendum(self) -> str:
        """Project Evidence sections that tie each added skill to its assigned role, for the evidence checks."""
        by_role: dict[str, list[str]] = {}
        for s in self.added:
            for company in s.roles:
                by_role.setdefault(company, []).append(s.term)
        return "\n\n".join(f"## {company}\nTechnologies: {', '.join(terms)}" for company, terms in by_role.items())


# ── posting sections ────────────────────────────────────────────────────────


def _heading_kind(line: str) -> str | None:
    """Section kind when *line* is a heading, else None."""
    s = line.strip().strip("*#").strip()
    if not s or len(s) > 80 or s.startswith(("-", "\u2022", "*")):
        return None
    words = s.rstrip(":").split()
    ends_colon = s.endswith(":")
    if len(words) > 9:
        return None
    if _BOILERPLATE_HEADING_RE.search(s.lower()) and (ends_colon or len(words) <= 7):
        return MENTIONED
    if REQUIRED_HEADING_RE.search(s) and (ends_colon or len(words) <= 6):
        return PREFERRED if _EXTRA_PREFERRED_RE.search(s) else REQUIRED
    if (PREFERRED_HEADING_RE.search(s) or _EXTRA_PREFERRED_RE.search(s)) and (ends_colon or len(words) <= 5):
        return PREFERRED
    if _CORE_HEADING_RE.search(s) and (ends_colon or len(words) <= 7):
        return CORE
    if s.lower().startswith(("required", "must have", "minimum")) and (ends_colon or len(words) <= 4):
        return REQUIRED
    return None


def posting_sections(*blobs: str) -> list[tuple[str, str]]:
    """(importance, line) for every non-empty posting line; headings set the importance."""
    out: list[tuple[str, str]] = []
    for blob in blobs:
        current = CORE
        for raw in str(blob or "").splitlines():
            line = raw.strip()
            if not line:
                continue
            if line.lower().startswith(("title:", "company:", "location:", "experience level:", "industry:")):
                out.append((CORE if line.lower().startswith(("title:", "industry:")) else MENTIONED, line))
                continue
            kind = _heading_kind(line)
            if kind:
                current = kind
                continue
            if _METADATA_LINE_RE.match(line) and len(line) <= 80:
                out.append((MENTIONED, line))
            elif current == REQUIRED and _EXTRA_PREFERRED_RE.search(line):
                out.append((PREFERRED, line))
            else:
                out.append((current, line))
    return out


def requirement_lines(job_text: str, structured_context: str = "", *, limit: int = 18) -> list[str]:
    """Sentence-length lines from the posting's requirement, preference and responsibility sections."""
    picked: list[tuple[int, int, str]] = []
    seen: set[str] = set()
    for pos, (kind, line) in enumerate(posting_sections(structured_context, job_text)):
        text = re.sub(r"^[\-\*\u2022]\s*", "", line).strip()
        min_len = 3 if text != line else 20
        if kind == MENTIONED or not (min_len <= len(text) <= 320) or text.endswith(":"):
            continue
        if line.lower().startswith(("title:", "industry:")):
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        picked.append((_RANK[kind], pos, text))
    picked.sort()
    return [t for _, _, t in picked[:limit]]


# ── skill terms in text ─────────────────────────────────────────────────────


def _token_spans(line: str) -> list[tuple[str, int, int]]:
    spans: list[tuple[str, int, int]] = []
    for m in _TOKEN_RE.finditer(line):
        offset = m.start()
        for part in m.group(0).split("/"):
            start = offset
            offset += len(part) + 1
            clean = part.rstrip(".-")
            if clean:
                spans.append((clean.lower(), start, start + len(clean)))
    return spans


def lexicon_hits(line: str) -> list[tuple[str, str]]:
    """(canonical, surface) for each lexicon skill in *line*, longest match first."""
    table, max_len = _lookup_table()
    spans = _token_spans(line)
    out: list[tuple[str, str]] = []
    i = 0
    while i < len(spans):
        hit = None
        for length in range(min(max_len, len(spans) - i), 0, -1):
            gram = " ".join(s[0] for s in spans[i:i + length])
            canonical = table.get(gram)
            if canonical:
                hit = (canonical, length)
                break
        if not hit:
            i += 1
            continue
        canonical, length = hit
        surface = line[spans[i][1]:spans[i + length - 1][2]].strip(" .,;:()")
        if length == 1 and surface.lower() in _ENGLISH_HOMONYMS:
            before = line[: spans[i][1]].rstrip()
            sentence_start = not before or before[-1] in ".!?:\u2022-("
            if not surface[:1].isupper() or sentence_start:
                i += 1
                continue
        out.append((canonical, surface))
        i += length
    return out


def _named_tokens(line: str) -> list[str]:
    """Product-like tokens the lexicon may not know: BigQuery, S3, GPT-4, ETL."""
    if line.upper() == line:
        return []
    out: list[str] = []
    for m in re.finditer(r"(?<![\w.])[A-Za-z][A-Za-z0-9+#.\-]*[A-Za-z0-9+#]", line):
        tok = m.group(0).rstrip(".")
        if len(tok) < 2 or not re.search(r"[A-Za-z]", tok):
            continue
        inner_cap = re.search(r"[a-z][A-Z]", tok) is not None
        has_digit = any(ch.isdigit() for ch in tok) and not re.fullmatch(r"[A-Z]\d{1,2}", tok)
        acronym = tok.isupper() and 2 <= len(tok) <= 6 and tok.isalpha() and tok not in _ACRONYM_STOP
        if inner_cap or has_digit or acronym:
            out.append(tok)
    return out


def _listed_items(line: str) -> list[str]:
    """Capitalised items of an explicit list ("such as Hadoop, Spark, and Kafka")."""
    out: list[str] = []
    for cue in _LIST_CUE_RE.finditer(line):
        tail = line[cue.end():]
        tail = re.split(r"[;:)]|\.(?=\s|$)", tail, maxsplit=1)[0]
        parts = re.split(r"\s*,\s*|\s+(?:and|or|and/or)\s+|\s*/\s*", tail)
        items: list[str] = []
        for part in parts:
            p = re.sub(r"^(?:and|or)\s+", "", part.strip())
            words = p.split()
            # "Delta data formats" -> "Delta": keep the capitalised lead words.
            lead: list[str] = []
            for w in words:
                if w[:1].isupper() or any(ch.isdigit() for ch in w) or any(ch in ".+#" for ch in w):
                    lead.append(w)
                else:
                    break
            cand = " ".join(lead[:3]).strip(" ,.")
            if not cand or not _LIST_ITEM_RE.match(cand):
                break
            items.append(cand)
        min_items = 2 if cue.group(0).startswith("(") else 3
        if len(items) >= min_items:
            out.extend(items)
    return out


def _alias_key(term: str) -> str:
    """One key per skill: lexicon clusters are too loose (data lake vs data warehousing), alias groups are not."""
    norm = _norm(term)
    for group in _ALIAS_GROUPS:
        if norm in group:
            return group[0]
    return norm


def job_skill_terms(job_text: str, structured_context: str = "", *, company: str = "") -> list[JobSkill]:
    """Skills the posting names, most important first, in the posting's own spelling."""
    found: dict[str, JobSkill] = {}
    order: dict[str, int] = {}
    company_key = _norm(company)

    def _add(term: str, kind: str, canonical: str | None, pos: int) -> None:
        term = term.strip(" .,;:()")
        key = _alias_key(term)
        if not term or not key or key in _GENERIC_SURFACES:
            return
        # "P99" is a latency percentile and "TN" a state, not skills.
        if term in _ACRONYM_STOP or _PERCENTILE_RE.fullmatch(term) or "," in term:
            return
        if company_key and _norm(term) in {company_key, *company_key.split()}:
            return
        prev = found.get(key)
        if prev is None or _RANK[kind] < _RANK[prev.importance]:
            found[key] = JobSkill(term if prev is None else prev.term, kind, canonical)
            order.setdefault(key, pos)

    for pos, (kind, line) in enumerate(posting_sections(structured_context, job_text)):
        for canonical, surface in lexicon_hits(line):
            _add(surface, kind, canonical, pos)
        if kind == MENTIONED:
            continue
        for tok in _named_tokens(line) + _listed_items(line):
            hits = lexicon_hits(tok)
            canonical = hits[0][0] if hits and _norm(hits[0][1]) == _norm(tok) else None
            _add(tok, kind, canonical, pos)
    ranked = sorted(found.items(), key=lambda kv: (_RANK[kv[1].importance], order[kv[0]]))
    return [skill for _, skill in ranked]


# ── profile support ─────────────────────────────────────────────────────────


def _is_injectable(skill: JobSkill, profile_skills: list[str]) -> bool:
    surface = _norm(skill.term)
    if surface in _GENERIC_SURFACES:
        return False
    if any(_norm(p) == surface for p in profile_skills):
        return True
    if skill.canonical:
        return SKILLS.get(skill.canonical, ("other",))[0] in _TECH_CATEGORIES
    return is_named_technology(skill.term)


def plan_required_skills(
    job_skills: list[JobSkill],
    profile_text: str,
    evidence_text: str = "",
    *,
    limit: int = 40,
) -> SkillPlan:
    """Split the posting's skills into supported (with the roles that show them), related and missing."""
    roles = parse_profile_roles(profile_text)
    texts = role_evidence_texts(roles, evidence_text) if roles else []
    source = "\n".join([profile_text or "", evidence_text or ""])
    profile_skills = parse_profile_skills(profile_text)
    profile_canon: dict[str, str] = {}
    for line in source.splitlines():
        for canonical, surface in lexicon_hits(line):
            profile_canon.setdefault(canonical, surface)

    plan = SkillPlan(
        posting_terms=[s.term for s in job_skills],
        has_required_section=any(s.importance == REQUIRED for s in job_skills),
    )
    role_canon = [{c for line in t.splitlines() for c, _ in lexicon_hits(line)} for t in texts]
    for skill in job_skills:
        if skill.importance == MENTIONED:
            continue
        category = _skill_category(skill)
        if is_mentioned(skill.term, source):
            if len(plan.supported) >= limit:
                continue
            plan.supported.append(
                RequiredSkill(
                    term=skill.term,
                    importance=skill.importance,
                    roles=[r.company for r, t in zip(roles, texts) if is_mentioned(skill.term, t)],
                    injectable=_is_injectable(skill, profile_skills),
                    category=category,
                )
            )
            continue
        wanted = skill.importance in (REQUIRED, PREFERRED) or (
            not plan.has_required_section and skill.importance == CORE
        )
        if wanted and roles and len(plan.added) < _MAX_ADDED_SKILLS and _is_addable(skill, category):
            pick = _best_role_for(skill, category, roles, role_canon, plan)
            plan.supported.append(
                RequiredSkill(
                    term=_added_display(skill),
                    importance=skill.importance,
                    roles=[roles[pick].company],
                    injectable=category in _TECH_CATEGORIES and _norm(skill.term) not in _GENERIC_SURFACES,
                    category=category,
                    added=True,
                )
            )
        elif skill.canonical and skill.canonical in profile_canon:
            plan.related.append((skill.term, profile_canon[skill.canonical]))
        elif wanted:
            plan.missing.append(skill.term)
    return plan


def _skill_category(skill: JobSkill) -> str | None:
    if not skill.canonical:
        return None
    return _CATEGORY_OVERRIDES.get(skill.canonical) or SKILLS.get(skill.canonical, (None,))[0]


def _is_addable(skill: JobSkill, category: str | None) -> bool:
    """A concrete technology or technique a resume can list; soft skills and industries are not."""
    if _norm(skill.term) in _GENERIC_SURFACES:
        return False
    if category:
        return category in _TECH_CATEGORIES
    return is_named_technology(skill.term) and skill.term[:1].isupper()


def _added_display(skill: JobSkill) -> str:
    """The posting's spelling, completed from the lexicon when the posting shortens it ("Delta" -> "Delta Lake")."""
    canon = skill.canonical or ""
    term = skill.term
    if " " not in term and canon.startswith(_norm(term) + " "):
        return " ".join(w[:1].upper() + w[1:] for w in canon.split())
    if term.islower() and (" " in term or len(term) > 4):
        return " ".join(w[:1].upper() + w[1:] for w in term.split())
    return term


def _best_role_for(
    skill: JobSkill,
    category: str | None,
    roles: list,
    role_canon: list[set[str]],
    plan: SkillPlan,
) -> int:
    """Index of the role whose real work is closest to *skill*: same-category stack, then posting overlap, then recency."""
    scores: list[tuple[float, int]] = []
    for idx, canon in enumerate(role_canon):
        same_cat = sum(1 for c in canon if (_CATEGORY_OVERRIDES.get(c) or SKILLS.get(c, ("",))[0]) == category)
        overlap = sum(1 for s in plan.supported if not s.added and roles[idx].company in s.roles)
        related = 3 if skill.canonical and skill.canonical in canon else 0
        bullets = sum(1 for ln in roles[idx].text.splitlines() if ln.strip().startswith("- "))
        thin = -5 if bullets < 2 else 0
        scores.append((related + same_cat + 0.5 * overlap + thin, -idx))
    return -max(scores)[1]


def required_skills_block(plan: SkillPlan) -> str:
    """Prompt block: every posting skill the profile supports, where it is evidenced, and what to leave out."""
    lines: list[str] = []
    held = [s for s in plan.supported if not s.added]
    if held:
        lines.append(
            "Supported by the profile (none may be missing; use the spelling shown). Each goes in technical_skills; "
            "each one tied to a role is also named in a bullet and in used_skills of that role:"
        )
        for s in held:
            where = ", ".join(s.roles) if s.roles else "skills list or summary only (technical_skills)"
            if not s.injectable:
                where += "; a practice, show it in a bullet rather than the skills list"
            long_form = _EXPANSIONS.get(_norm(s.term))
            if long_form and long_form.lower() != _norm(s.term):
                where += f" (spell out once: {long_form} ({s.term}))"
            lines.append(f"- {s.term} [{s.importance}]: {where}")
    else:
        lines.append("- (No skill the posting names appears in the profile.)")
    if plan.added:
        lines.append(
            "Add to the resume (the posting requires these and the profile does not name them yet; none may be "
            "missing). Each goes in technical_skills under its category, and in used_skills and at least one bullet "
            "of the role shown, describing how that role's real work used it (same product, scope and metrics):"
        )
        for s in plan.added:
            lines.append(f"- {s.term} [{s.importance}]: {', '.join(s.roles)}")
    if plan.related:
        lines.append(
            "Related evidence (the profile uses a different term; name the profile's term in the role that "
            "shows it, and the posting's term only if that is truthful):"
        )
        lines.extend(f"- {job} (profile: {mine})" for job, mine in plan.related[:15])
    if plan.missing:
        lines.append(
            "Not in the profile (never claim, list or hint at these): " + ", ".join(plan.missing[:25])
        )
    return "\n".join(lines)


# ── enforcing on a tailored resume ──────────────────────────────────────────


def _experience_text(resume: dict) -> str:
    parts = [str(resume.get("profile_summary") or "")]
    for entry in resume.get("work_experience") or []:
        if isinstance(entry, dict):
            parts.append(str(entry.get("project_description") or ""))
            parts.extend(b for b in entry.get("bullets") or [] if isinstance(b, str))
    return "\n".join(parts)


def missing_from_experience(resume: dict | None, plan: SkillPlan | None) -> list[RequiredSkill]:
    """Required skills a role evidences that no bullet, project description or summary names."""
    if not resume or not isinstance(resume, dict) or not plan:
        return []
    text = _experience_text(resume)
    return [s for s in plan.must_name_in_roles() if not is_mentioned(s.term, text)]


def _display_term(term: str, profile_skills: list[str]) -> str:
    for item in profile_skills:
        if _norm(item) == _norm(term):
            return item
    if term.islower() and (" " in term or len(term) > 4):
        return " ".join(w[:1].upper() + w[1:] for w in term.split())
    return term


def _pick_category(rows: list[dict], skill: RequiredSkill, profile_text: str) -> int | None:
    names = [str(r.get("category") or "") for r in rows]
    # Same category as the profile's own skills block puts it in, matched through a sibling item.
    for line in profile_text.split("## Technical Skills", 1)[-1].split("\n## ", 1)[0].splitlines():
        s = line.strip().lstrip("-*\u2022 ")
        if ":" not in s:
            continue
        items = split_skill_items(s.split(":", 1)[1])
        if not any(_norm(i) == _norm(skill.term) or is_mentioned(skill.term, i) for i in items):
            continue
        for idx, row in enumerate(rows):
            row_items = split_skill_items(str(row.get("skills") or ""))
            if any(_norm(a) == _norm(b) for a in row_items for b in items):
                return idx
    wanted = _SECTION_NAMES.get(skill.category or "", ())
    for want in wanted:
        for idx, name in enumerate(names):
            if name.lower() == want.lower() or want.lower() in name.lower():
                return idx
    from app.utils.resume_skill_taxonomy import _lexicon_home

    home = _lexicon_home(skill.term, names)
    return names.index(home) if home in names else None


def _dedupe_skill_rows(rows: list[dict], plan: SkillPlan) -> list[dict]:
    """One item per skill across the section ("Amazon Web Services, AWS" -> "AWS"), in the posting's spelling."""
    posting = {_alias_key(s.term): s.term for s in plan.supported}
    merged: dict[str, dict] = {}
    for row in rows:
        name = str(row.get("category") or "").strip().lower()
        if name in merged:
            prev = merged[name]
            prev["skills"] = ", ".join(x for x in (str(prev.get("skills") or ""), str(row.get("skills") or "")) if x)
        else:
            merged[name] = dict(row)
    rows = list(merged.values())
    seen: dict[str, tuple[int, int]] = {}
    cleaned: list[list[str]] = []
    for r_idx, row in enumerate(rows):
        items: list[str] = []
        cleaned.append(items)
        for item in split_skill_items(str(row.get("skills") or "")):
            key = _alias_key(item)
            want = posting.get(key)
            if key in seen:
                if want and _norm(item) == _norm(want):
                    i, j = seen[key]
                    cleaned[i][j] = item
                continue
            if item.islower() and " " in item:
                item = " ".join(w[:1].upper() + w[1:] for w in item.split())
            seen[key] = (r_idx, len(items))
            items.append(item)
    return [{**row, "skills": ", ".join(items)} for row, items in zip(rows, cleaned) if items]


def ensure_required_skills(resume: dict | None, plan: SkillPlan | None, profile_text: str) -> dict | None:
    """Add every supported posting skill the model left out: to technical_skills, and to used_skills of the roles that evidence it."""
    if not resume or not isinstance(resume, dict) or not plan or not plan.supported:
        return resume
    profile_skills = parse_profile_skills(profile_text)
    rows = [dict(r) for r in resume.get("technical_skills") or [] if isinstance(r, dict)]
    added: list[str] = []
    for skill in plan.supported:
        if not skill.injectable:
            continue
        blob = ", ".join(str(r.get("skills") or "") for r in rows)
        if is_mentioned(skill.term, blob):
            continue
        term = _display_term(skill.term, profile_skills)
        idx = _pick_category(rows, skill, profile_text)
        if idx is None:
            name = _NEW_SECTION.get(skill.category or "", "Tools")
            rows.append({"category": name, "skills": term})
        else:
            current = str(rows[idx].get("skills") or "").strip().rstrip(",")
            rows[idx]["skills"] = f"{current}, {term}" if current else term
        added.append(term)
    resume["technical_skills"] = _dedupe_skill_rows(rows, plan)
    if added:
        logger.info("tailored_resume_required_skills_added", skills=added)

    for entry in resume.get("work_experience") or []:
        if not isinstance(entry, dict):
            continue
        used = str(entry.get("used_skills") or "").strip()
        items = [i for i in split_skill_items(used) if i]
        for skill in plan.supported:
            if not skill.injectable or skill.importance == MENTIONED or len(items) >= 14:
                continue
            if not any(companies_match(entry.get("company_name"), c) for c in skill.roles):
                continue
            if any(is_mentioned(skill.term, i) for i in items):
                continue
            items.append(_display_term(skill.term, profile_skills))
        if items:
            entry["used_skills"] = ", ".join(dict.fromkeys(items))
    return resume
