"""Job-first tailoring: the experience is rewritten around the posting's stack.

The original resume supplies who the candidate is (contact details, education),
where and when they worked (company, title, dates, location) and what each
company's product or domain was. What each role says the candidate did is
written for the posting: its required skills become the primary stack of the
two most recent roles, older roles use the parts of that stack that existed
while they ran, and the only numbers allowed are ones the original resume
states for the same company. Technologies from the original resume survive only
when they complement the posting's stack (another cloud, another database).
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
from app.services.tech_eras import current_year, period_year, usable_in_role
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

STRATEGY_JOB_FIRST = "job_first"
STRATEGY_EVIDENCE = "evidence"
DEFAULT_STRATEGY = STRATEGY_JOB_FIRST

MAX_REWRITE_RETRIES = 2

_MAX_SKILLS = 40
_MAX_COMPLEMENTARY = 8
_MAX_METRICS_PER_ROLE = 6
_MAX_USED_SKILLS = 14
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
        "onsite", "on site", "discovery", "growth", "platform", "us", "usa", "eeo",
    }
)
# Employer pitch and legal text; skills found only in these lines are not the job's.
BOILERPLATE_RE = re.compile(
    r"\b(?:equal opportunity|without regard to|join us|our (?:core )?values|our mission|our culture|about us|"
    r"we(?:'|\u2019)re (?:legendary|proud|one of|committed)|we are (?:proud|committed|an equal)|"
    r"journey starts|reasonable (?:accommodations?|adjustments)|pronouns|celebrate diversity|posting notes|"
    r"(?:still )?want to hear from you)\b",
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


def normalize_strategy(raw: object) -> str:
    return STRATEGY_EVIDENCE if str(raw or "").strip().lower() == STRATEGY_EVIDENCE else STRATEGY_JOB_FIRST


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
    stack: list[str] = field(default_factory=list)
    too_new: list[str] = field(default_factory=list)

    @property
    def period(self) -> str:
        return " - ".join(p for p in (self.role.period_start, self.role.period_end or "Present") if p)


@dataclass
class JobFirstPlan:
    skills: list[RequiredSkill]
    roles: list[RolePlan]
    complementary: list[str]
    off_target: list[str]
    total_years: float | None
    has_required_section: bool

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


def profile_technologies(profile_text: str, roles: list[ProfileRole] | None = None) -> list[str]:
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


def _total_years(roles: list[ProfileRole]) -> float | None:
    now = current_year()
    spans: list[tuple[int, int]] = []
    for role in roles:
        start = period_year(role.period_start)
        if start is None:
            continue
        end = period_year(role.period_end) if role.period_end else now
        end = end or now
        if start <= end <= now + 1:
            spans.append((start, end))
    if not spans:
        return None
    spans.sort()
    total = 0
    cur_start, cur_end = spans[0]
    for start, end in spans[1:]:
        if start <= cur_end:
            cur_end = max(cur_end, end)
        else:
            total += cur_end - cur_start
            cur_start, cur_end = start, end
    total += cur_end - cur_start
    return float(max(total, 1))


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


def build_job_first_plan(job_skills: list[JobSkill], profile_text: str, job_text: str = "") -> JobFirstPlan:
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
            category in _TECH_CATEGORIES and category != "practice" if category else is_named_technology(term)
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

    role_plans: list[RolePlan] = []
    for idx, role in enumerate(roles):
        is_current = not role.period_end
        end_year = current_year() if is_current else period_year(role.period_end)
        name, desc = role_project(role)
        clues = ""
        if not desc:
            clues = " ".join(_contribution_lines(role))[:_DOMAIN_CLUE_CHARS].strip()
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
        )
        for s in skills:
            (plan_role.stack if usable_in_role(s.term, end_year, is_current=is_current) else plan_role.too_new).append(
                s.term
            )
        role_plans.append(plan_role)

    plan = JobFirstPlan(
        skills=skills,
        roles=role_plans,
        complementary=[],
        off_target=[],
        total_years=_total_years(roles),
        has_required_section=has_required,
    )
    primary_ids = {id(s) for s in plan.primary}
    for s in skills:
        homes = [r for r in plan.recent if s.term in r.stack]
        if id(s) not in primary_ids:
            homes = homes[:1]
        s.roles = [r.role.company for r in homes]

    job_categories = {s.category for s in skills if s.category and s.category != "practice"}
    for term in profile_technologies(profile_text, roles):
        if any(_alias_key(term) == _alias_key(s.term) or is_mentioned(term, s.term) for s in skills):
            continue
        if _term_category(term) in job_categories:
            if len(plan.complementary) < _MAX_COMPLEMENTARY:
                plan.complementary.append(term)
        else:
            plan.off_target.append(term)
    return plan


# ── prompt blocks ───────────────────────────────────────────────────────────


def career_facts_block(plan: JobFirstPlan) -> str:
    if not plan.roles:
        return "No structured work history found in the profile."
    lines: list[str] = []
    if plan.total_years:
        lines.append(f"Total professional experience: about {int(plan.total_years)} years (from the dates below).")
    lines.append("Roles, most recent first (index in brackets):")
    for r in plan.roles:
        head = f"- [{r.index}] {r.role.company} | {r.role.title} | {r.period}"
        if r.meta:
            head += f" | {r.meta}"
        lines.append(head)
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


def target_stack_block(plan: JobFirstPlan) -> str:
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
        lines.append("Older roles use the posting's stack too, limited to what existed while they ran:")
        for r in older:
            stack = ", ".join(r.stack) or "(none of the posting's technologies existed yet)"
            line = f"- [{r.index}] {r.role.company} ({r.period}): {stack}"
            if r.too_new:
                line += f". Never here: {', '.join(r.too_new)}"
            lines.append(line)
    if plan.complementary:
        lines.append(
            "Complementary skills from the candidate's background (technical_skills after the posting's "
            "skills; at most one bullet per role may name one): " + ", ".join(plan.complementary)
        )
    if plan.off_target:
        lines.append(
            "Never name anywhere (the candidate's old stack, which this posting does not use): "
            + ", ".join(plan.off_target[:40])
        )
    return "\n".join(lines)


# ── finishing a draft ───────────────────────────────────────────────────────


def _canonical_term(item: str, allowed: list[str]) -> str | None:
    key = _alias_key(item)
    for term in allowed:
        if key == _alias_key(term):
            return term
    for term in allowed:
        if is_mentioned(item, term) or is_mentioned(term, item):
            return term
    return None


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


def finalize_job_first_resume(resume: dict | None, plan: JobFirstPlan, profile_text: str, job_text: str) -> dict | None:
    """Restore the career facts and make the skills sections the posting's stack."""
    if not resume or not isinstance(resume, dict):
        return resume
    matched = restore_role_facts(resume, profile_text)
    entries = [e for e in resume.get("work_experience") or [] if isinstance(e, dict)]
    roles = {r.index: r for r in plan.roles}
    recent = {r.index for r in plan.recent}
    primary = [s.term for s in plan.primary]
    for entry, idx in zip(entries, matched):
        role = roles.get(idx) if idx is not None else None
        allowed = (role.stack if role else plan.terms) + plan.complementary
        items: list[str] = []
        for item in split_skill_items(str(entry.get("used_skills") or "")):
            term = _canonical_term(item, allowed)
            if term and term not in items:
                items.append(term)
        if role and idx in recent:
            for term in primary:
                if term in role.stack and term not in items:
                    items.append(term)
        order = {t: i for i, t in enumerate(allowed)}
        items.sort(key=lambda t: order.get(t, len(order)))
        entry["used_skills"] = ", ".join(items[:_MAX_USED_SKILLS]) or None

    allowed_skills = plan.terms + plan.complementary
    rows: list[dict] = []
    for row in resume.get("technical_skills") or []:
        if not isinstance(row, dict):
            continue
        kept: list[str] = []
        for item in split_skill_items(str(row.get("skills") or "")):
            term = _canonical_term(item, allowed_skills)
            if term and term not in kept:
                kept.append(term)
        if kept:
            rows.append({**row, "skills": ", ".join(kept)})
    resume["technical_skills"] = rows
    resume = ensure_required_skills(resume, plan.skill_plan, profile_text) or resume
    rows = _dedupe_skill_rows(resume.get("technical_skills") or [], plan.skill_plan)
    keep_text = "\n".join([job_text, ", ".join(plan.terms)])
    resume["technical_skills"] = order_skills_for_posting(cap_skills_section(rows, keep_text), plan.terms)
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


def job_first_problems(resume: dict | None, plan: JobFirstPlan, profile_text: str) -> dict[str, str]:
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
        off = _named(plan.off_target, prose + "\n" + str(entry.get("used_skills") or ""))
        if off:
            problems[f"work_experience[{pos}]_off_target_technology"] = (
                f"{company}: names {', '.join(off)}, which the posting does not use. Describe the same work "
                "with the posting's stack instead."
            )
        early = _named(role.too_new, prose)
        if early:
            problems[f"work_experience[{pos}]_anachronistic_technology"] = (
                f"{company} ({role.period}): {', '.join(early)} did not exist yet. Use only that role's listed stack."
            )
        invented = _invented_numbers(entry, role, plan.terms + plan.complementary)
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
    off = _named(plan.off_target, summary)
    if off:
        problems["profile_summary_off_target_technology"] = (
            f"profile_summary names {', '.join(off)}; lead with the posting's primary skills instead."
        )
    title = summary_opening_title(summary)
    held = {w for r in roles for w in _norm(r.title).split()}
    over = [w for w in _norm(title).split() if w in _ABOVE_SENIOR and w not in held]
    if over:
        problems["profile_summary_level_above_held"] = (
            f'profile_summary opens with "{title}", a level the candidate never held. Keep the posting\'s title '
            "family at the candidate's own level."
        )
    return problems


def experience_skill_coverage(resume: dict | None, plan: JobFirstPlan) -> float:
    """Share of the placeable posting skills named inside a role's bullets or project description."""
    pool = plan.placeable
    if not resume or not pool:
        return 0.0 if pool else 1.0
    prose = "\n".join(_entry_prose(e) for e in resume.get("work_experience") or [] if isinstance(e, dict))
    return round(sum(1 for t in pool if is_mentioned(t, prose)) / len(pool), 3)


def job_first_retry_note(problems: dict[str, str], extra: list[str] | None = None) -> str:
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
