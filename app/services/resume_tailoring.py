"""Resume tailoring: the candidate's real career, written to fit one posting.

The original resume supplies who the candidate is (contact details, education),
where and when they worked (company, title, dates, location), what each
company's product or domain was, and the technologies each role used. What each
role says the candidate did is written fresh: the posting's required skills
become the primary stack of the two most recent roles, every role's scope fits
its tenure and career stage (a first job reads as learning, a long senior role
reads as owning systems), and the candidate's wider stack stays, so the career
reads as one engineer's story rather than a copy of the posting. The only
numbers allowed are ones the original resume states for the same company.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.services.required_skills import (
    CORE,
    MENTIONED,
    PREFERRED,
    REQUIRED,
    JobSkill,
    RequiredSkill,
    SkillPlan,
    _CATEGORY_OVERRIDES,
    _GENERIC_SURFACES,
    _TECH_CATEGORIES,
    _added_display,
    _alias_key,
    _dedupe_skill_rows,
    _is_addable,
    _skill_category,
    ensure_required_skills,
    lexicon_hits,
)
from app.services.skill_lexicon import SKILLS
from app.services.tech_eras import current_year, period_month_index, period_year, usable_in_role
from app.utils.resume_evidence import (
    _ABOVE_SENIOR,
    _EXPANSIONS,
    _GENERIC_CONCEPTS,
    _METRIC_RE,
    _match_roles,
    _norm,
    _sections,
    ProfileRole,
    cap_skills_section,
    is_mentioned,
    is_named_technology,
    parse_profile_roles,
    parse_profile_skills,
    restore_role_facts,
    role_project,
    split_skill_items,
    summary_opening_title,
)
from app.utils.resume_skill_taxonomy import fill_thin_skill_rows, fold_small_skill_rows

STRATEGY_REBUILD = "job_first"
STRATEGY_EVIDENCE = "evidence"
DEFAULT_STRATEGY = STRATEGY_REBUILD

MAX_REWRITE_RETRIES = 2

_MAX_SKILLS = 40
# The candidate's own technologies beyond the posting's: the breadth a real career has.
_MAX_BREADTH = 30
_MAX_METRICS_PER_ROLE = 6
_MAX_USED_SKILLS = 16
# A senior engineer's skills section: 5-7 categories of 6 or more items each.
MIN_SKILL_CATEGORIES = 5
MIN_SKILLS_PER_CATEGORY = 6
MAX_SKILL_ITEMS = 56
# A summary describes the engineer; the skills section lists the stack.
MAX_SUMMARY_TECHNOLOGIES = 3
# Two technologies beyond the posting's per recent role keep the story from reading copied from it.
MIN_BREADTH_PER_RECENT_ROLE = 2
MAX_TERMS_PER_BULLET = 6
# Acronyms the lexicon does not know (KYC, SOC 2, PII) are the posting's domain vocabulary: bullets may
# name them, but they are not technologies to add to the skills section.
_DOMAIN_ACRONYM_RE = re.compile(r"(?=(?:[^A-Z]*[A-Z]){2})[A-Za-z]{2,5}(?: \d+)?")
_DOMAIN_CLUE_CHARS = 320
# A tailored bullet sharing this many consecutive words with an original bullet reuses it.
_REUSE_RUN = 6
_SKIP_PREFIXES = ("technologies:", "project:", "project description:")
# Posting words the skill reader picks up that are not skills a role can show (benefits, HR and
# compliance acronyms, generic nouns).
_NOT_SKILLS = frozenset(
    {
        "ui", "ux", "api", "apis", "ip", "time", "fast", "full time", "part time", "medical", "dental", "vision",
        "401k", "insurance", "equity", "benefits", "dod", "itc", "rfp", "rfi", "remote", "hybrid",
        "onsite", "on site", "discovery", "growth", "platform", "us", "usa", "eeo", "linkedin", "fortune 500",
    }
)
# Employer pitch, legal text and recruiter outreach ("I reviewed your LinkedIn profile"); skills found
# only in these lines are not the job's.
BOILERPLATE_RE = re.compile(
    r"\b(?:equal opportunity|without regard to|join us|our (?:core )?values|our mission|our culture|about us|"
    r"we(?:'|\u2019)re (?:legendary|proud|one of|committed)|we are (?:proud|committed|an equal)|"
    r"journey starts|reasonable (?:accommodations?|adjustments)|pronouns|celebrate diversity|posting notes|"
    r"(?:still )?want to hear from you|dear [A-Z][a-z]+|your (?:linkedin|profile|background|resume)|"
    r"linkedin profile|phone (?:conversation|call)|actively looking|accurate resource|near future|"
    r"(?:had|have) a chance to review|reach(?:ing)? out|current work situation|interested in hearing)\b",
    re.IGNORECASE,
)
# Certifications are earned, not shown in work: tailoring never adds them.
_CERTIFICATION_RE = re.compile(
    r"\b(comptia|security\+|cissp|cism|cisa|ceh|pmp|itil|ccna|ccnp|ccie|oscp|gsec|casp|certified|certification)\b",
    re.IGNORECASE,
)
_TRAILING_VERSION_RE = re.compile(r"\s*v?\d+(?:\.\d+)*\+?$")
# Lexicon categories that name a way of working, shown in a bullet rather than listed as a skill.
_PRACTICE_CATEGORIES = frozenset({"practice", "architecture"})


STAGE_EARLY = "early"
STAGE_MID = "mid"
STAGE_SENIOR = "senior"
_EARLY_TITLE_RE = re.compile(r"\b(intern|internship|trainee|junior|jr\.?|graduate|apprentice|entry[- ]level)\b", re.I)
_SENIOR_TITLE_RE = re.compile(r"\b(senior|sr\.?|lead|staff|principal|architect|head|director|manager)\b", re.I)
# (tenure in months below which, (min, max) bullets)
_BULLETS_BY_TENURE: tuple[tuple[int, tuple[int, int]], ...] = (
    (6, (2, 3)),
    (12, (3, 4)),
    (24, (4, 5)),
    (36, (5, 6)),
    (60, (6, 8)),
    (10**6, (7, 9)),
)
_STAGE_SCOPE = {
    STAGE_EARLY: (
        "early career: learning the craft on real work. Implements features and fixes under code review, "
        "writes tests, learns the codebase, tooling and delivery process, and grows into owning small "
        "components. Never leads, architects or mentors."
    ),
    STAGE_MID: (
        "mid-level: owns features and services end to end inside an existing architecture, designs components, "
        "improves reliability and performance, reviews peers' code and works directly with product partners."
    ),
    STAGE_SENIOR: (
        "senior: owns the design and technical direction of the product area, makes architecture and tradeoff "
        "decisions, builds and evolves several major systems over the tenure, raises engineering standards "
        "(testing, CI/CD, observability, security), mentors engineers and leads cross-team work."
    ),
}


def role_stage(title: str, career_year: float | None) -> str:
    """Career stage from the title first, then from *career_year*: years of experience halfway through the role."""
    if _EARLY_TITLE_RE.search(title or ""):
        return STAGE_EARLY
    if _SENIOR_TITLE_RE.search(title or ""):
        return STAGE_SENIOR
    if career_year is None:
        return STAGE_MID
    if career_year < 2:
        return STAGE_EARLY
    return STAGE_MID if career_year < 5 else STAGE_SENIOR


def normalize_strategy(raw: object) -> str:
    return STRATEGY_EVIDENCE if str(raw or "").strip().lower() == STRATEGY_EVIDENCE else STRATEGY_REBUILD


@dataclass
class RolePlan:
    index: int
    role: ProfileRole
    end_year: int | None
    is_current: bool
    meta: str
    project_name: str
    project_description: str
    domain_clues: str
    metrics: list[str]
    months: int | None = None
    # Years of professional experience when the role started.
    career_year: float | None = None
    stage: str = STAGE_MID
    stack: list[str] = field(default_factory=list)
    too_new: list[str] = field(default_factory=list)
    own_stack: list[str] = field(default_factory=list)

    @property
    def period(self) -> str:
        return " - ".join(p for p in (self.role.period_start, self.role.period_end or "Present") if p)

    @property
    def tenure(self) -> str:
        if self.months is None:
            return "undated"
        years, months = divmod(self.months, 12)
        parts = [f"{years} year{'s' if years != 1 else ''}"] if years else []
        if months or not years:
            parts.append(f"{months} month{'s' if months != 1 else ''}")
        return " ".join(parts)

    @property
    def bullet_range(self) -> tuple[int, int]:
        """Bullets the role's tenure supports: a six-month first job is not a four-year senior role."""
        m = self.months
        if m is None:
            return (4, 6)
        for limit, span in _BULLETS_BY_TENURE:
            if m < limit:
                return span
        return _BULLETS_BY_TENURE[-1][1]


@dataclass
class TailoringPlan:
    skills: list[RequiredSkill]
    roles: list[RolePlan]
    breadth: list[str]
    total_years: float | None
    has_required_section: bool

    @property
    def max_bullets(self) -> int:
        return sum(r.bullet_range[1] for r in self.roles)

    @property
    def years_label(self) -> str:
        years = self.total_years or 0
        whole = int(years)
        return f"{whole}+ years" if years - whole >= 0.5 else f"{max(whole, 1)} years"

    @property
    def career_level(self) -> str:
        top = self.roles[0].stage if self.roles else STAGE_MID
        years = self.total_years or 0
        if top == STAGE_SENIOR or years >= 6:
            return "a senior engineer whose depth, judgment and scope show in every recent role"
        if top == STAGE_EARLY or years < 2:
            return "an early-career engineer who learned fast and shipped real work"
        return "a mid-level engineer who owns features and services end to end"

    @property
    def terms(self) -> list[str]:
        return [s.term for s in self.skills]

    @property
    def primary(self) -> list[RequiredSkill]:
        """Required technologies; practices (API design, microservices) only need one bullet."""
        wanted = {REQUIRED} if self.has_required_section else {REQUIRED, CORE}
        return [s for s in self.skills if s.importance in wanted and s.category != "practice"]

    @property
    def secondary(self) -> list[RequiredSkill]:
        primary = {id(s) for s in self.primary}
        return [s for s in self.skills if id(s) not in primary]

    @property
    def placeable(self) -> list[str]:
        """Posting skills a recent role can carry; a skill newer than every role cannot be shown."""
        homed = [s.term for s in self.skills if s.roles]
        return homed if self.roles else self.terms

    @property
    def recent(self) -> list[RolePlan]:
        return self.roles[:2]

    @property
    def skill_plan(self) -> SkillPlan:
        """The same skills as a SkillPlan, so the shared skills-section helpers can place them."""
        return SkillPlan(
            supported=self.skills,
            posting_terms=self.terms,
            has_required_section=self.has_required_section,
        )


# ── reading the profile ─────────────────────────────────────────────────────


def _term_category(term: str) -> str | None:
    hits = lexicon_hits(term)
    if not hits or _norm(hits[0][1]) != _norm(term):
        return None
    canonical = hits[0][0]
    return _CATEGORY_OVERRIDES.get(canonical) or SKILLS.get(canonical, (None,))[0]


def _is_technology(term: str) -> bool:
    if _norm(term) in _GENERIC_CONCEPTS or _norm(term) in _GENERIC_SURFACES:
        return False
    category = _term_category(term)
    if category:
        return category in _TECH_CATEGORIES and category != "practice"
    return is_named_technology(term)


def profile_technologies(
    profile_text: str, roles: list[ProfileRole] | None = None, *, include_skills_section: bool = True
) -> list[str]:
    """Every named technology the original resume mentions, most recent role first."""
    roles = parse_profile_roles(profile_text) if roles is None else roles
    found: list[str] = []
    for role in roles:
        for line in role.text.splitlines():
            s = line.strip()
            if s.lower().startswith("technologies:"):
                found.extend(split_skill_items(s.split(":", 1)[1]))
            else:
                found.extend(surface for _, surface in lexicon_hits(s))
    if include_skills_section:
        found.extend(parse_profile_skills(profile_text))
    seen: set[str] = set()
    out: list[str] = []
    for term in found:
        key = _alias_key(term)
        if key and key not in seen and _is_technology(term):
            seen.add(key)
            out.append(term)
    return out


def _role_meta(role: ProfileRole) -> str:
    lines = [ln.strip() for ln in role.text.splitlines()[1:] if ln.strip()]
    if lines and not lines[0].startswith("-") and not lines[0].lower().startswith(_SKIP_PREFIXES):
        return lines[0]
    return ""


def _contribution_lines(role: ProfileRole) -> list[str]:
    return [ln.strip()[1:].strip() for ln in role.text.splitlines() if ln.strip().startswith("-")]


def _role_metrics(role: ProfileRole) -> list[str]:
    """Clauses of the role's text that state a number, e.g. "cut p95 latency by 40%"."""
    out: list[str] = []
    for line in role.text.splitlines():
        s = line.strip().lstrip("-*\u2022 ").strip()
        if not s or s.lower().startswith(_SKIP_PREFIXES):
            continue
        for clause in re.split(r";\s+|,\s+(?=[a-z])|\.\s+", s):
            clause = clause.strip(" .")
            if _METRIC_RE.search(clause) and clause not in out:
                out.append(clause[:160])
    return out[:_MAX_METRICS_PER_ROLE]


def _role_span(role: ProfileRole) -> tuple[int, int] | None:
    """(first month, last month) of the role, both inclusive, as year * 12 + month indexes."""
    start = period_month_index(role.period_start)
    end = period_month_index(role.period_end, is_end=True)
    if start is None or end is None or end < start:
        return None
    return start, end


def _total_years(roles: list[ProfileRole]) -> float | None:
    """Years worked, overlapping roles counted once."""
    spans = sorted(s for s in (_role_span(r) for r in roles) if s)
    if not spans:
        return None
    total = 0
    cur_start, cur_end = spans[0]
    for start, end in spans[1:]:
        if start <= cur_end + 1:
            cur_end = max(cur_end, end)
        else:
            total += cur_end - cur_start + 1
            cur_start, cur_end = start, end
    total += cur_end - cur_start + 1
    return max(round(total / 12, 1), 0.5)


def _carryable(skill: JobSkill, category: str | None, job_text: str) -> bool:
    """A skill a role can show in its work.

    Lexicon skills count by category. Unknown terms need a product-like spelling (digit, symbol or
    inner capital), or, for acronyms and Title Case names, a requirements or preferences line;
    that keeps team names, benefits and section words out.
    """
    term = skill.term.strip()
    if _norm(term) in _NOT_SKILLS or _CERTIFICATION_RE.search(term):
        return False
    homes = [ln for ln in (job_text or "").splitlines() if is_mentioned(term, ln)]
    if homes and all(BOILERPLATE_RE.search(ln) for ln in homes):
        return False
    if not _is_addable(skill, category):
        return False
    if skill.canonical:
        return True
    if any(ch.isdigit() or ch in ".#+" for ch in term) or re.search(r"[a-z][A-Z]", term):
        return True
    listed = skill.importance in (REQUIRED, PREFERRED)
    if term.isupper() and term.isalpha() and 3 <= len(term) <= 6:
        return listed or len(re.findall(rf"\b{re.escape(term)}\b", job_text or "")) >= 2
    return listed and len(term.split()) <= 3


def build_tailoring_plan(job_skills: list[JobSkill], profile_text: str, job_text: str = "") -> TailoringPlan:
    """The posting's skills, where each may go in the career, and what the profile keeps."""
    roles = parse_profile_roles(profile_text)
    has_required = any(s.importance == REQUIRED for s in job_skills)
    skills: list[RequiredSkill] = []
    seen: set[str] = set()
    for skill in job_skills:
        if skill.importance == MENTIONED or len(skills) >= _MAX_SKILLS:
            continue
        category = _skill_category(skill)
        if not _carryable(skill, category, job_text):
            continue
        term = _added_display(skill)
        canonical = skill.canonical or ""
        if canonical.startswith(".") and _norm(term) == canonical[1:]:
            term = "." + term
        key = _alias_key(term)
        if key in seen:
            continue
        seen.add(key)
        if category in _PRACTICE_CATEGORIES:
            category = "practice"
        injectable = (
            category in _TECH_CATEGORIES and category != "practice"
            if category
            else is_named_technology(term) and not _DOMAIN_ACRONYM_RE.fullmatch(term)
        ) and _norm(term) not in _GENERIC_SURFACES
        skills.append(
            RequiredSkill(term=term, importance=skill.importance, injectable=injectable, category=category, added=True)
        )
    # Fragments of another posting skill (".NET 8+" read as "NET" and "NET 8+") go.
    known = [s for s in skills if s.category]
    skills = [
        s
        for s in skills
        if s.category
        or not any(
            k is not s and is_mentioned(_TRAILING_VERSION_RE.sub("", s.term) or s.term, k.term) for k in known
        )
    ]

    def is_posting_skill(term: str) -> bool:
        return any(_alias_key(term) == _alias_key(s.term) or is_mentioned(term, s.term) for s in skills)

    spans = [_role_span(r) for r in roles]
    career_start = min((s[0] for s in spans if s), default=None)
    role_plans: list[RolePlan] = []
    for idx, (role, span) in enumerate(zip(roles, spans)):
        is_current = not role.period_end
        end_year = current_year() if is_current else period_year(role.period_end)
        name, desc = role_project(role)
        clues = ""
        if not desc:
            clues = " ".join(_contribution_lines(role))[:_DOMAIN_CLUE_CHARS].strip()
        career_year = round((span[0] - career_start) / 12, 1) if span and career_start is not None else None
        midpoint = career_year + (span[1] - span[0] + 1) / 24 if span and career_year is not None else None
        plan_role = RolePlan(
            index=idx,
            role=role,
            end_year=end_year,
            is_current=is_current,
            meta=_role_meta(role),
            project_name=name,
            project_description=desc,
            domain_clues=clues,
            metrics=_role_metrics(role),
            months=span[1] - span[0] + 1 if span else None,
            career_year=career_year,
            stage=role_stage(role.title, midpoint),
            own_stack=[
                t for t in profile_technologies(profile_text, [role], include_skills_section=False)
                if not is_posting_skill(t)
            ][:12],
        )
        for s in skills:
            (plan_role.stack if usable_in_role(s.term, end_year, is_current=is_current) else plan_role.too_new).append(
                s.term
            )
        role_plans.append(plan_role)

    plan = TailoringPlan(
        skills=skills,
        roles=role_plans,
        breadth=[t for t in profile_technologies(profile_text, roles) if not is_posting_skill(t)][:_MAX_BREADTH],
        total_years=_total_years(roles),
        has_required_section=has_required,
    )
    primary_ids = {id(s) for s in plan.primary}
    for s in skills:
        homes = [r for r in plan.recent if s.term in r.stack]
        if id(s) not in primary_ids:
            homes = homes[:1]
        s.roles = [r.role.company for r in homes]
    return plan


# ── prompt blocks ───────────────────────────────────────────────────────────


def career_facts_block(plan: TailoringPlan) -> str:
    if not plan.roles:
        return "No structured work history found in the profile."
    lines: list[str] = []
    if plan.total_years:
        lines.append(
            f"Total professional experience: about {plan.years_label} (from the dates below). The resume reads "
            f"as an engineer with that career: {plan.career_level}."
        )
    lines.append(
        f"Roles, most recent first (index in brackets). Bullets: {plan.max_bullets} at most in total; each role "
        "uses the range shown, so a long role carries more work than a short one."
    )
    for r in plan.roles:
        head = f"- [{r.index}] {r.role.company} | {r.role.title} | {r.period}"
        if r.meta:
            head += f" | {r.meta}"
        lines.append(head)
        low, high = r.bullet_range
        career = f", starting {r.career_year:g} years into the career" if r.career_year is not None else ""
        lines.append(f"  Tenure: {r.tenure}{career}. Bullets: {low}-{high}.")
        lines.append(f"  Scope: {_STAGE_SCOPE[r.stage]}")
        if r.project_name:
            lines.append(f"  Project: {r.project_name}")
        if r.project_description:
            lines.append(f"  Product / domain: {r.project_description}")
        elif r.domain_clues:
            lines.append(
                "  Domain clues (only to learn the product and industry; never reuse these tasks, tools or "
                f"wording): {r.domain_clues}"
            )
        if r.metrics:
            lines.append("  Results you may reuse at this company only: " + "; ".join(r.metrics))
    return "\n".join(lines)


def education_block(profile_text: str) -> str:
    sections = _sections(profile_text)
    lines: list[str] = []
    for name, body in sections.items():
        if name.startswith(("education", "certif", "award")):
            content = [ln for ln in body if ln.strip()]
            if content:
                lines.append(f"{name.title()}:")
                lines.extend(content[:12])
    return "\n".join(lines) or "None listed."


def _spell_out(term: str) -> str:
    long_form = _EXPANSIONS.get(_norm(term))
    return f" (spell out once: {long_form} ({term}))" if long_form and long_form.lower() != _norm(term) else ""


def target_stack_block(plan: TailoringPlan) -> str:
    if not plan.skills:
        return "- The posting names no specific technologies; write the work around its responsibilities."
    lines: list[str] = []
    recent = ", ".join(f"[{r.index}]" for r in plan.recent) or "[0]"
    lines.append(
        f"Primary skills (the posting requires them). Name every one in bullets of {recent} and in their "
        "used_skills, in the spelling shown:"
    )
    for s in plan.primary:
        lines.append(f"- {s.term}{_spell_out(s.term)}")
    if plan.secondary:
        lines.append(f"Other posting skills. Name each in at least one bullet of {recent}:")
        for s in plan.secondary:
            lines.append(f"- {s.term} [{s.importance}]{_spell_out(s.term)}")
    for r in plan.recent:
        if r.too_new:
            lines.append(
                f"- [{r.index}] {r.role.company} ended before these existed; leave them out of that role: "
                + ", ".join(r.too_new)
            )
    older = plan.roles[2:]
    if older:
        # Terms the lexicon knows; the rest is the posting's own vocabulary (KYC, SOC 2, product names).
        technologies = {s.term for s in plan.skills if s.category}
        lines.append(
            "Older roles may use the posting's technologies where their own product would, limited to what "
            "existed while they ran; never the posting's domain or compliance vocabulary:"
        )
        for r in older:
            stack = ", ".join(t for t in r.stack if t in technologies) or "(none of the posting's technologies existed yet)"
            line = f"- [{r.index}] {r.role.company} ({r.period}): {stack}"
            if r.too_new:
                line += f". Never here: {', '.join(r.too_new)}"
            lines.append(line)
    lines.append(
        "Career breadth (a real engineer's stack is wider than one posting). Each role also names technologies "
        f"beyond the posting's (at least {MIN_BREADTH_PER_RECENT_ROLE} in each of {recent}): first the ones the "
        "candidate actually used there, listed below; then the surrounding ecosystem a senior engineer with "
        "this stack uses in that kind of product (testing, CI/CD, observability, security, data stores, cloud "
        "services, messaging). Only technologies that existed while the role ran, and in the two most recent "
        "roles the posting's skills stay the lead."
    )
    for r in plan.roles:
        if r.own_stack:
            lines.append(f"- [{r.index}] {r.role.company} used: {', '.join(r.own_stack)}")
    if plan.breadth:
        lines.append("- Elsewhere in the candidate's background: " + ", ".join(plan.breadth))
    return "\n".join(lines)


# ── finishing a draft ───────────────────────────────────────────────────────


def order_skills_for_posting(rows: list[dict], terms: list[str]) -> list[dict]:
    """Posting skills lead: categories holding them first, and within each category in posting order."""
    rank = {_alias_key(t): i for i, t in enumerate(terms)}

    def item_rank(item: str) -> int:
        key = _alias_key(item)
        if key in rank:
            return rank[key]
        hit = next((i for t, i in ((t, rank[_alias_key(t)]) for t in terms) if is_mentioned(t, item)), None)
        return hit if hit is not None else len(terms) + 1

    ordered: list[tuple[int, int, dict]] = []
    for pos, row in enumerate(rows):
        items = sorted(split_skill_items(str(row.get("skills") or "")), key=item_rank)
        if not items:
            continue
        ordered.append((min(item_rank(i) for i in items), pos, {**row, "skills": ", ".join(items)}))
    ordered.sort(key=lambda x: (x[0], x[1]))
    return [row for _, _, row in ordered]


_SOFT_SKILLS = frozenset(
    {
        "communication", "leadership", "teamwork", "collaboration", "problem solving", "problem-solving",
        "mentoring", "ownership", "time management", "critical thinking", "adaptability", "agile", "scrum",
        "kanban", "stakeholder management", "attention to detail",
    }
)


def _skill_item(item: str, plan: TailoringPlan, role: RolePlan | None = None) -> str | None:
    """The item as the skills sections show it: the posting's spelling, or the technology itself.

    None for soft skills, for practices the posting does not list, and for anything the role's
    dates predate.
    """
    key = _alias_key(item)
    # Exact match only: "AWS Lambda" is its own skill, not the posting's "AWS".
    posting = next((t for t in plan.terms if _alias_key(t) == key), None)
    if posting:
        return posting if role is None or posting in role.stack else None
    clean = item.strip()
    if not clean or _norm(clean) in _SOFT_SKILLS or not _is_technology(clean):
        return None
    if role is not None and not usable_in_role(clean, role.end_year, is_current=role.is_current):
        return None
    return clean


# Parsers such as Taleo garble typographic punctuation.
_PLAIN_PUNCTUATION = str.maketrans(
    {"\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"', "\u2013": "-", "\u2026": "...", "\u00a0": " "}
)


def _plain_prose(resume: dict) -> None:
    if isinstance(resume.get("profile_summary"), str):
        resume["profile_summary"] = resume["profile_summary"].translate(_PLAIN_PUNCTUATION)
    for entry in resume.get("work_experience") or []:
        if not isinstance(entry, dict):
            continue
        if isinstance(entry.get("project_description"), str):
            entry["project_description"] = entry["project_description"].translate(_PLAIN_PUNCTUATION)
        entry["bullets"] = [
            b.translate(_PLAIN_PUNCTUATION) if isinstance(b, str) else b for b in entry.get("bullets") or []
        ]


def finalize_tailored_resume(resume: dict | None, plan: TailoringPlan, profile_text: str, job_text: str) -> dict | None:
    """Restore the career facts; skills sections lead with the posting's stack and keep the career's breadth."""
    if not resume or not isinstance(resume, dict):
        return resume
    _plain_prose(resume)
    matched = restore_role_facts(resume, profile_text)
    entries = [e for e in resume.get("work_experience") or [] if isinstance(e, dict)]
    roles = {r.index: r for r in plan.roles}
    recent = {r.index for r in plan.recent}
    primary = [s.term for s in plan.primary]
    rank = {t: i for i, t in enumerate(plan.terms)}
    for entry, idx in zip(entries, matched):
        role = roles.get(idx) if idx is not None else None
        # A role lists what its own bullets show, not the posting's whole stack.
        work = " ".join(str(b) for b in entry.get("bullets") or []).replace("**", "")
        items: list[str] = []
        candidates = split_skill_items(str(entry.get("used_skills") or ""))
        if role and idx in recent:
            candidates += [t for t in primary if t in role.stack]
        # Proper names only: "architecture" or the "NET" of ".NET" is not a listed technology.
        candidates += [t for t in _technologies_in(work) if t != t.lower()]
        for item in candidates:
            term = _skill_item(item, plan, role)
            if (
                term
                and _is_technology(term)
                and is_mentioned(term, work)
                and not any(_alias_key(term) == _alias_key(t) or is_mentioned(term, t) for t in items)
            ):
                items.append(term)
        items.sort(key=lambda t: rank.get(t, len(rank)))
        entry["used_skills"] = ", ".join(items[:_MAX_USED_SKILLS]) or None

    rows: list[dict] = []
    for row in resume.get("technical_skills") or []:
        if not isinstance(row, dict):
            continue
        kept: list[str] = []
        for item in split_skill_items(str(row.get("skills") or "")):
            term = _skill_item(item, plan)
            if term and all(_alias_key(term) != _alias_key(t) for t in kept):
                kept.append(term)
        if kept:
            rows.append({**row, "skills": ", ".join(kept)})
    resume["technical_skills"] = rows
    resume = ensure_required_skills(resume, plan.skill_plan, profile_text) or resume
    rows = _dedupe_skill_rows(resume.get("technical_skills") or [], plan.skill_plan)
    rows = fill_thin_skill_rows(fold_small_skill_rows(rows), plan.placeable + plan.breadth, MIN_SKILLS_PER_CATEGORY)
    keep_text = "\n".join([job_text, ", ".join(plan.terms)])
    resume["technical_skills"] = order_skills_for_posting(
        cap_skills_section(rows, keep_text, limit=MAX_SKILL_ITEMS), plan.terms
    )
    return resume


def tailored_resume_to_profile_text(resume: dict, profile_text: str) -> str:
    """The tailored resume in the profile text format, keeping the profile's header and education."""
    head = (profile_text or "").split("\n## ", 1)[0].strip()
    if head.startswith("## "):
        head = ""
    parts: list[str] = [head] if head else []
    summary = str(resume.get("profile_summary") or "").replace("**", "").strip()
    if summary:
        parts += ["## Summary", summary, ""]
    rows = [r for r in resume.get("technical_skills") or [] if isinstance(r, dict)]
    if rows:
        parts.append("## Technical Skills")
        parts += [f"- **{r.get('category')}**: {r.get('skills')}" for r in rows]
        parts.append("")
    entries = [e for e in resume.get("work_experience") or [] if isinstance(e, dict)]
    if entries:
        parts.append("## Work Experience")
        for e in entries:
            period = " - ".join(p for p in (e.get("period_start"), e.get("period_end") or "Present") if p)
            header = f"**{e.get('company_name') or ''}** | {e.get('job_title') or ''}"
            parts.append(header + (f" | {period}" if e.get("period_start") else ""))
            if e.get("project_name"):
                parts.append(f"Project: {e['project_name']}")
            if e.get("project_description"):
                parts.append(f"Project description: {str(e['project_description']).replace('**', '')}")
            parts += [f"- {str(b).replace('**', '')}" for b in e.get("bullets") or [] if isinstance(b, str)]
            if e.get("used_skills"):
                parts.append(f"Technologies: {e['used_skills']}")
            parts.append("")
    for name, body in _sections(profile_text).items():
        if name in ("summary", "technical skills", "work experience"):
            continue
        content = [ln for ln in body if ln.strip()]
        if content:
            parts += [f"## {name.title()}", *content, ""]
    return "\n".join(parts).strip()


# ── checks ──────────────────────────────────────────────────────────────────

_NUMBER_RE = re.compile(r"\d[\d,]*(?:\.\d+)?")


def _entry_prose(entry: dict) -> str:
    return "\n".join(
        [str(entry.get("project_description") or "")]
        + [b for b in entry.get("bullets") or [] if isinstance(b, str)]
    ).replace("**", "")


def _numbers(text: str) -> set[str]:
    return {m.group(0).replace(",", "").rstrip(".") for m in _NUMBER_RE.finditer(text or "")}


_VERSION_AFTER_NAME_RE = re.compile(r"(?<=[A-Za-z#+.])\s?v?\d+(?:\.\d+)*\+?")


def _without_technology_names(text: str, terms: list[str]) -> str:
    """Drop technology names and their versions (".NET 8+", "Python 3.12", "OAuth 2.0") before reading numbers."""
    out = text
    for term in sorted(terms, key=len, reverse=True):
        out = re.sub(re.escape(term) + r"(?:\s?v?\d+(?:\.\d+)*\+?)?", " ", out, flags=re.IGNORECASE)
    words = []
    for word in out.split(" "):
        words.append(_VERSION_AFTER_NAME_RE.sub("", word) if re.match(r"^[A-Za-z][\w.#+-]*\d", word) else word)
    return " ".join(words)


def _invented_numbers(entry: dict, role: RolePlan, terms: list[str]) -> list[str]:
    allowed = _numbers(role.role.text)
    out: list[str] = []
    for bullet in [str(entry.get("project_description") or "")] + list(entry.get("bullets") or []):
        if not isinstance(bullet, str):
            continue
        for m in _METRIC_RE.finditer(_without_technology_names(bullet.replace("**", ""), terms)):
            for num in _numbers(m.group(0)):
                if num not in allowed and m.group(0).strip() not in out:
                    out.append(m.group(0).strip())
    return out


def _tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9][a-z0-9+#.]*", _norm(text))


def _reused_bullets(entry: dict, role: RolePlan) -> list[str]:
    grams: set[tuple[str, ...]] = set()
    for line in _contribution_lines(role.role):
        toks = _tokens(line)
        grams.update(tuple(toks[i:i + _REUSE_RUN]) for i in range(len(toks) - _REUSE_RUN + 1))
    out: list[str] = []
    for bullet in entry.get("bullets") or []:
        if not isinstance(bullet, str):
            continue
        toks = _tokens(bullet)
        if any(tuple(toks[i:i + _REUSE_RUN]) in grams for i in range(len(toks) - _REUSE_RUN + 1)):
            out.append(bullet.replace("**", "")[:90])
    return out


def _named(terms: list[str], text: str) -> list[str]:
    return [t for t in terms if is_mentioned(t, text)]


def _technologies_in(text: str) -> list[str]:
    """Lexicon technologies *text* names, each once, in the text's spelling."""
    out: list[str] = []
    seen: set[str] = set()
    for line in (text or "").replace("**", "").splitlines():
        for canonical, surface in lexicon_hits(line):
            if canonical not in seen and _is_technology(surface):
                seen.add(canonical)
                out.append(surface)
    return out


_ABOVE_EARLY_RE = re.compile(
    r"\b(led|architected|mentored|directed|spearheaded|headed|set the technical direction|"
    r"owned the (?:architecture|technical direction))\b",
    re.IGNORECASE,
)
_SENIOR_SCOPE_RE = re.compile(
    r"\b(architect\w*|designed|led|mentor\w*|owned|drove|defined|established|standardi[sz]ed|"
    r"technical direction|roadmap|cross-team|tradeoffs?)\b",
    re.IGNORECASE,
)
_MIN_SENIOR_SCOPE_BULLETS = 2


def _role_shape_problems(pos: int, entry: dict, role: RolePlan, plan: TailoringPlan) -> dict[str, str]:
    """Bullets for the tenure, scope for the career stage, and breadth beyond the posting."""
    problems: dict[str, str] = {}
    company = role.role.company
    bullets = [b.replace("**", "") for b in entry.get("bullets") or [] if isinstance(b, str) and b.strip()]
    low, high = role.bullet_range
    if len(bullets) < low:
        problems[f"work_experience[{pos}]_too_few_bullets_for_tenure"] = (
            f"{company} ({role.tenure}) has {len(bullets)} bullets; that tenure carries {low}-{high}. Add work of "
            "the scope the role's stage shows."
        )
    elif len(bullets) > high + 1:
        problems[f"work_experience[{pos}]_too_many_bullets_for_tenure"] = (
            f"{company} ({role.tenure}) has {len(bullets)} bullets; that tenure carries {low}-{high}. Merge the "
            "least important."
        )
    if role.stage == STAGE_EARLY:
        above = [b[:80] for b in bullets if _ABOVE_EARLY_RE.search(b)]
        if above:
            problems[f"work_experience[{pos}]_scope_above_stage"] = (
                f"{company} is an early-career role ({role.tenure}); it implements, tests and learns, never leads, "
                "architects or mentors: " + "; ".join(f'"{b}"' for b in above[:2])
            )
    elif role.stage == STAGE_SENIOR and len(bullets) >= 3:
        if sum(1 for b in bullets if _SENIOR_SCOPE_RE.search(b)) < _MIN_SENIOR_SCOPE_BULLETS:
            problems[f"work_experience[{pos}]_scope_below_stage"] = (
                f"{company} is a senior role ({role.tenure}) but reads like task work. Show design decisions, "
                "technical direction, standards the candidate set and engineers they mentored."
            )
    stuffed = [b[:80] for b in bullets if len(_named_terms(b, plan)) > MAX_TERMS_PER_BULLET]
    if stuffed:
        problems[f"work_experience[{pos}]_keyword_stuffing"] = (
            f"{company}: a bullet names at most {MAX_TERMS_PER_BULLET} technologies or posting terms; these read as "
            "keyword lists. Keep the ones the work really used and describe what was built: "
            + "; ".join(f'"{b}"' for b in stuffed[:2])
        )
    is_recent = any(r.index == role.index for r in plan.recent)
    if not is_recent:
        jargon = [
            s.term
            for s in plan.skills
            if not s.category
            and any(is_mentioned(s.term, b) for b in bullets)
            and not is_mentioned(s.term, role.role.text)
        ]
        if jargon:
            problems[f"work_experience[{pos}]_posting_domain_in_older_role"] = (
                f"{company}: {', '.join(jargon[:6])} belong to the posting's domain, not to this earlier role. "
                "Older roles keep their own product and domain."
            )
    if is_recent:
        beyond = [t for t in _technologies_in("\n".join(bullets)) if not plan_mentions_term(plan, t)]
        if len(beyond) < MIN_BREADTH_PER_RECENT_ROLE:
            problems[f"work_experience[{pos}]_no_career_breadth"] = (
                f"{company} names only the posting's technologies, which reads as written for this job. Also show "
                f"at least {MIN_BREADTH_PER_RECENT_ROLE} technologies the work would really involve beyond the "
                "posting's (testing, CI/CD, observability, data stores, cloud services), starting with: "
                + (", ".join(role.own_stack[:6]) or "the ecosystem around the posting's stack")
            )
    return problems


def _named_terms(bullet: str, plan: TailoringPlan) -> list[str]:
    posting = [s.term for s in plan.skills if is_mentioned(s.term, bullet)]
    return posting + [t for t in _technologies_in(bullet) if not plan_mentions_term(plan, t)]


def plan_mentions_term(plan: TailoringPlan, term: str) -> bool:
    return any(_alias_key(term) == _alias_key(s.term) or is_mentioned(term, s.term) for s in plan.skills)


def _skills_section_problems(resume: dict) -> dict[str, str]:
    rows = [r for r in resume.get("technical_skills") or [] if isinstance(r, dict)]
    sizes = [(str(r.get("category") or ""), len(split_skill_items(str(r.get("skills") or "")))) for r in rows]
    thin = [f"{cat} ({n})" for cat, n in sizes if n < MIN_SKILLS_PER_CATEGORY]
    if len(sizes) >= MIN_SKILL_CATEGORIES and not thin:
        return {}
    return {
        "technical_skills_too_thin": (
            f"technical_skills has {len(sizes)} categories" + (f"; too few items in {', '.join(thin)}" if thin else "")
            + f". A senior engineer's skills section has {MIN_SKILL_CATEGORIES}-7 categories with at least "
            f"{MIN_SKILLS_PER_CATEGORY} items each, from the whole career: the posting's stack first, then the "
            "related tools, services and libraries the work used."
        )
    }


def tailoring_problems(resume: dict | None, plan: TailoringPlan, profile_text: str) -> dict[str, str]:
    """Issue code -> what is wrong, for the retry note. Empty when the draft meets every rule."""
    if not resume or not isinstance(resume, dict):
        return {"missing_tailored_resume": "No resume was returned."}
    problems: dict[str, str] = {}
    entries = [e for e in resume.get("work_experience") or [] if isinstance(e, dict)]
    roles = parse_profile_roles(profile_text)
    by_index = {r.index: r for r in plan.roles}
    recent = {r.index for r in plan.recent}
    all_prose = ""
    for pos, (entry, idx) in enumerate(zip(entries, _match_roles(entries, roles))):
        role = by_index.get(idx) if idx is not None else None
        prose = _entry_prose(entry)
        all_prose += "\n" + prose
        if role is None:
            continue
        company = role.role.company
        if idx in recent:
            missing = [s.term for s in plan.primary if s.term in role.stack and not is_mentioned(s.term, prose)]
            if missing:
                problems[f"work_experience[{pos}]_missing_primary_skills"] = (
                    f"{company}: no bullet names {', '.join(missing)}. Write them into this role's work."
                )
        early = _named(role.too_new, prose)
        early += [
            t for t in _technologies_in(prose)
            if t not in early and not usable_in_role(t, role.end_year, is_current=role.is_current)
        ]
        if early:
            problems[f"work_experience[{pos}]_anachronistic_technology"] = (
                f"{company} ({role.period}): {', '.join(early)} did not exist yet. Use only technologies that "
                "existed while the role ran."
            )
        problems.update(_role_shape_problems(pos, entry, role, plan))
        invented = _invented_numbers(entry, role, plan.terms + plan.breadth + _technologies_in(prose))
        if invented:
            problems[f"work_experience[{pos}]_invented_metric"] = (
                f"{company}: {'; '.join(invented[:4])} is not a result the profile states for this company. Use "
                "only that company's reusable results, or state the concrete outcome without a number."
            )
        reused = _reused_bullets(entry, role)
        if reused and (len(reused) >= 2 or len(reused) * 3 > len(entry.get("bullets") or [])):
            problems[f"work_experience[{pos}]_reuses_original_wording"] = (
                f"{company}: these bullets repeat the original resume; write new work for the posting: "
                + "; ".join(f'"{b}"' for b in reused[:3])
            )
    missing_any = [s.term for s in plan.secondary if s.roles and not is_mentioned(s.term, all_prose)]
    if missing_any:
        problems["posting_skills_missing_from_experience"] = (
            "No bullet names " + ", ".join(missing_any) + ". Name each in a bullet of one of the two most recent roles."
        )
    summary = str(resume.get("profile_summary") or "")
    named = _technologies_in(summary)
    if len(named) > MAX_SUMMARY_TECHNOLOGIES:
        problems["profile_summary_lists_technologies"] = (
            f"profile_summary names {len(named)} technologies ({', '.join(named[:8])}), repeating the skills and "
            f"experience sections. Name at most {MAX_SUMMARY_TECHNOLOGIES}; describe the engineer instead: the "
            "kind of systems and domains across the career, how they work and lead, and what they are known for."
        )
    problems.update(_skills_section_problems(resume))
    title = summary_opening_title(summary)
    held = {w for r in roles for w in _norm(r.title).split()}
    over = [w for w in _norm(title).split() if w in _ABOVE_SENIOR and w not in held]
    if over:
        problems["profile_summary_level_above_held"] = (
            f'profile_summary opens with "{title}", a level the candidate never held. Keep the posting\'s title '
            "family at the candidate's own level."
        )
    return problems


def experience_skill_coverage(resume: dict | None, plan: TailoringPlan) -> float:
    """Share of the placeable posting skills named inside a role's bullets or project description."""
    pool = plan.placeable
    if not resume or not pool:
        return 0.0 if pool else 1.0
    prose = "\n".join(_entry_prose(e) for e in resume.get("work_experience") or [] if isinstance(e, dict))
    return round(sum(1 for t in pool if is_mentioned(t, prose)) / len(pool), 3)


def tailoring_retry_note(problems: dict[str, str], extra: list[str] | None = None) -> str:
    lines = [
        "QUALITY RETRY: revise your previous draft above and return the full resume. Keep the bullets that "
        "already work; rewrite or add bullets to fix every point below."
    ]
    lines += [f"- {text}" for text in problems.values()]
    lines += [f"- {text}" for text in extra or []]
    lines.append(
        "Keep company names, titles and dates verbatim and keep each role's product and domain; every other "
        "sentence is written for this posting."
    )
    return "\n".join(lines)
