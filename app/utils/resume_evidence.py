"""Role-level evidence for resume tailoring.

ATS parsers (Textkernel, RChilli, Phenom) credit a skill with months of experience
only from the dated role it appears in, and AI screeners cite the line that proves a
requirement. A technology the profile lists in its global skills block is therefore
not evidence that a particular role used it. This module reads the profile text built
by ``user_profile_to_openai_text`` and keeps each tailored role to what that role's
own text (or its company's Project Evidence) names.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.utils.company_name import companies_match, normalize_company_name

_SECTION_RE = re.compile(r"^##\s+(.+?)\s*$")
_ROLE_HEADER_RE = re.compile(r"^\*\*(?P<company>[^*]+)\*\*(?P<rest>.*)$")
_PERIOD_SPLIT_RE = re.compile(r"\s+[-\u2013]\s+")
_CURRENT_WORDS = frozenset({"present", "current", "now"})

# Slash pairs that name one concept and must not be split into two items.
_KEEP_SLASH = frozenset({"ci/cd", "ai/ml", "tcp/ip", "ui/ux", "a/b", "pl/sql", "i/o"})

# Spellings that refer to the same technology. Lower case; the first entry is canonical.
_ALIAS_GROUPS: tuple[tuple[str, ...], ...] = (
    ("kubernetes", "k8s", "aks", "eks", "gke"),
    ("aws", "amazon web services"),
    ("gcp", "google cloud", "google cloud platform"),
    ("azure", "microsoft azure"),
    ("postgresql", "postgres"),
    ("node.js", "nodejs"),
    ("react", "react.js", "reactjs"),
    ("next.js", "nextjs"),
    (".net", "dotnet", ".net core", "asp.net", "c#/.net"),
    ("ci/cd", "continuous integration", "continuous delivery", "continuous deployment"),
    ("llm", "llms", "large language model", "large language models"),
    ("rest", "rest api", "rest apis", "restful"),
    ("amazon s3", "s3", "aws s3"),
    ("sagemaker", "aws sagemaker", "amazon sagemaker"),
    ("entra id", "azure ad", "microsoft entra id", "azure active directory"),
    ("machine learning", "ml"),
    ("nlp", "natural language processing"),
    ("generative ai", "genai", "gen ai"),
)
_ALIASES: dict[str, tuple[str, ...]] = {a: group for group in _ALIAS_GROUPS for a in group}

_VENDOR_PREFIXES = ("microsoft ", "amazon ", "aws ", "azure ", "google ", "gcp ", "apache ")

# Capitalised profile skill items that describe a practice, not a named technology.
# They may still be checked in used_skills, but bullets may describe the practice freely.
_GENERIC_CONCEPTS = frozenset(
    {
        "microservices", "classification", "regression", "summarization", "forecasting",
        "event-driven architecture", "event driven architecture", "async processing",
        "data modeling", "time-series analytics", "time-series forecasting", "anomaly detection",
        "risk scoring", "vector search", "etl", "elt", "rbac", "iam", "testing", "automation",
        "monitoring", "observability", "security", "networking", "debugging", "design patterns",
        "api design", "system design", "distributed systems", "data structures", "algorithms",
        "rest", "web services", "unit testing", "integration testing", "mlops", "devops", "nlp",
        "machine learning", "deep learning", "generative ai", "llm", "llms", "ner", "ml", "ai",
    }
)

_METRIC_RE = re.compile(
    r"\d+(?:\.\d+)?\s?(?:%|x\b|k\b|m\b|ms\b|tb\b|gb\b|\+)|\$\s?\d|"
    r"\b\d[\d,.]*\s+(?:users|customers|clients|requests|transactions|events|records|"
    r"engineers|developers|services|teams|hours|days|weeks|minutes|seconds|million|billion|"
    r"thousand|countries|sites|assets|devices|models)\b",
    re.IGNORECASE,
)
# Quantities stated in words; broad adjectives ("large-scale", "real-time") match nearly every line.
_SCALE_WORDS = ("fleets", "millions", "billions", "thousands of", "hundreds of")
# Seniority and engineering-quality evidence that recruiters and AI screeners weigh for
# almost any senior posting, and that a length budget tends to cut first.
_SIGNAL_RE = re.compile(
    r"\b(mentor\w*|coach\w*|led\b|lead\b|leading|owned|ownership|collaborat\w*|partner\w* with|stakeholder\w*|"
    r"cross-functional|evaluation criteria|precision|recall|test coverage|automated test\w*|"
    r"dashboards?|audit\w*|compliance|rbac|access control\w*|incident\w*|on-call|code review\w*|"
    r"design review\w*|architecture review\w*|best practices)\b",
    re.IGNORECASE,
)
# Long forms worth spelling out once next to the acronym ("Amazon Web Services (AWS)").
_EXPANSIONS = {
    "aws": "Amazon Web Services", "gcp": "Google Cloud Platform", "llm": "Large Language Model",
    "llms": "Large Language Models", "nlp": "Natural Language Processing", "ml": "Machine Learning",
    "ci/cd": "Continuous Integration and Continuous Delivery", "rbac": "Role-Based Access Control",
    "iam": "Identity and Access Management", "etl": "Extract, Transform, Load", "rag": "Retrieval-Augmented Generation",
    "sdet": "Software Development Engineer in Test", "ehr": "Electronic Health Records",
    "genai": "Generative AI", "mlops": "Machine Learning Operations", "sre": "Site Reliability Engineering",
}


@dataclass(frozen=True)
class ProfileRole:
    company: str
    title: str
    period_start: str
    period_end: str
    text: str


def _norm(text: str) -> str:
    s = (text or "").replace("**", "").lower()
    s = re.sub(r"[\u2010-\u2015]", "-", s)
    s = re.sub(r"(?<=[a-z0-9])-(?=[a-z0-9])", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _sections(profile_text: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    current = ""
    for line in (profile_text or "").splitlines():
        m = _SECTION_RE.match(line.strip())
        if m:
            current = m.group(1).strip().lower()
            out.setdefault(current, [])
            continue
        if current:
            out[current].append(line)
    return out


def _split_period(period: str) -> tuple[str, str]:
    parts = _PERIOD_SPLIT_RE.split(period.strip(), maxsplit=1)
    start = parts[0].strip() if parts else ""
    end = parts[1].strip() if len(parts) > 1 else ""
    if end.lower() in _CURRENT_WORDS:
        end = ""
    return start, end


def parse_profile_roles(profile_text: str) -> list[ProfileRole]:
    """Work experience entries (most recent first) with each role's own text."""
    lines = _sections(profile_text).get("work experience") or []
    roles: list[ProfileRole] = []
    header: tuple[str, str, str, str] | None = None
    body: list[str] = []

    def _flush() -> None:
        if header:
            company, title, start, end = header
            roles.append(ProfileRole(company, title, start, end, "\n".join(body).strip()))

    for line in lines:
        m = _ROLE_HEADER_RE.match(line.strip())
        if m:
            _flush()
            rest = [p.strip() for p in m.group("rest").split("|")]
            rest = [p for p in rest if p]
            title = rest[0] if rest else ""
            start, end = _split_period(rest[1]) if len(rest) > 1 else ("", "")
            header = (m.group("company").strip(), title, start, end)
            body = [title]
            continue
        if header is not None:
            body.append(line)
    _flush()
    return roles


def split_skill_items(raw: str) -> list[str]:
    """'Python(FastAPI, Django), C#/.NET, xUnit/NUnit' -> Python, FastAPI, Django, C#, .NET, xUnit, NUnit."""
    text = re.sub(r"[()\[\]]", ",", (raw or "").replace("**", ""))
    items: list[str] = []
    for part in re.split(r"\s*[,;|\u00b7\u2022]\s*", text):
        part = part.strip(" \t").rstrip(".:").strip()
        if not part:
            continue
        if "/" in part and " " not in part and part.lower() not in _KEEP_SLASH:
            pieces = [p for p in part.split("/") if p]
            if len(pieces) > 1 and all(len(p) >= 2 for p in pieces):
                items.extend(pieces)
                continue
        items.append(part)
    return items


def parse_profile_skills(profile_text: str) -> list[str]:
    """Technologies from the profile's global Technical Skills block, in profile order."""
    out: list[str] = []
    seen: set[str] = set()
    for line in _sections(profile_text).get("technical skills") or []:
        s = line.strip().lstrip("-*\u2022 ").strip()
        if not s:
            continue
        if ":" in s:
            s = s.split(":", 1)[1]
        for item in split_skill_items(s):
            key = item.lower()
            if key not in seen:
                seen.add(key)
                out.append(item)
    return out


def evidence_by_company(evidence_text: str) -> dict[str, str]:
    """Project Evidence pack sections keyed by normalised company name."""
    out: dict[str, str] = {}
    current = ""
    buf: list[str] = []
    for line in (evidence_text or "").splitlines():
        m = _SECTION_RE.match(line.strip())
        if m:
            if current:
                out[current] = "\n".join(buf)
            current = normalize_company_name(m.group(1))
            buf = []
            continue
        if current:
            buf.append(line)
    if current:
        out[current] = "\n".join(buf)
    return out


def _forms(term: str) -> list[str]:
    base = _norm(term)
    if not base:
        return []
    forms = {base}
    outside = _norm(re.sub(r"\([^)]*\)", " ", term))
    if outside:
        forms.add(outside)
    for inner in re.findall(r"\(([^)]*)\)", term):
        for piece in split_skill_items(inner):
            forms.add(_norm(piece))
    raw = re.sub(r"\([^)]*\)", " ", term).strip()
    for prefix in _VENDOR_PREFIXES:
        if raw.lower().startswith(prefix):
            rest_raw = raw[len(prefix):].strip()
            # "Microsoft Entra ID" -> "Entra ID", but never "Azure Machine Learning" -> "machine learning".
            if len(rest_raw) >= 2 and _looks_named(rest_raw):
                forms.add(_norm(rest_raw))
            break
    for f in list(forms):
        forms.update(_ALIASES.get(f, ()))
        if len(f) > 4 and f.endswith("s") and not f.endswith("ss"):
            forms.add(f[:-1])
    return [f for f in forms if f]


def _looks_named(term: str) -> bool:
    """Product-like spelling: a digit or symbol, or a word with inner capitals (OpenAI, S3, ID)."""
    return any(ch.isdigit() or ch in ".#+" for ch in term) or any(
        any(ch.isupper() for ch in word[1:]) for word in term.split()
    )


def is_mentioned(term: str, text: str) -> bool:
    """True when *term* (or a known alias) appears in *text* as a whole word or phrase."""
    hay = _norm(text)
    if not hay:
        return False
    for form in _forms(term):
        if re.search(r"(?<![a-z0-9])" + re.escape(form) + r"(?![a-z0-9])", hay):
            return True
    return False


def is_named_technology(term: str) -> bool:
    """A specific product or language (Kubernetes, PyTest, C#), not a practice (Microservices)."""
    t = re.sub(r"\([^)]*\)", "", term or "").strip()
    if not t or _norm(t) in _GENERIC_CONCEPTS or len(t) > 40:
        return False
    if any(ch.isdigit() or ch in ".#+" for ch in t):
        return True
    words = t.split()
    if any(any(ch.isupper() for ch in w[1:]) for w in words):
        return True
    return all(w[:1].isupper() for w in words) and len(words) <= 3 and len(t) >= 3


def role_evidence_texts(roles: list[ProfileRole], evidence_text: str = "") -> list[str]:
    """Each role's own text plus its company's Project Evidence section."""
    by_company = evidence_by_company(evidence_text)
    out: list[str] = []
    for role in roles:
        extra = [txt for key, txt in by_company.items() if companies_match(key, role.company)]
        out.append("\n".join([role.text, *extra]))
    return out


def _match_roles(entries: list[dict], roles: list[ProfileRole]) -> list[int | None]:
    """Profile role index for each tailored entry (company first, then position)."""
    used: set[int] = set()
    out: list[int | None] = []
    for pos, entry in enumerate(entries):
        company = entry.get("company_name") if isinstance(entry, dict) else None
        pick = next(
            (i for i, r in enumerate(roles) if i not in used and companies_match(company, r.company)),
            None,
        )
        if pick is None and pos < len(roles) and pos not in used:
            pick = pos
        if pick is not None:
            used.add(pick)
        out.append(pick)
    return out


def role_terms(text: str, candidates: list[str], *, limit: int = 30) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for term in candidates:
        key = _norm(term)
        if not key or key in seen:
            continue
        if is_mentioned(term, text):
            seen.add(key)
            out.append(term)
        if len(out) >= limit:
            break
    return out


def _role_candidates(profile_text: str, role: ProfileRole, extra_terms: list[str]) -> list[str]:
    own: list[str] = []
    for line in role.text.splitlines():
        if line.strip().lower().startswith("technologies:"):
            own.extend(split_skill_items(line.split(":", 1)[1]))
    return own + parse_profile_skills(profile_text) + list(extra_terms)


def enforce_role_evidence(
    resume: dict | None,
    profile_text: str,
    evidence_text: str = "",
) -> dict | None:
    """Restore immutable role facts and drop technologies a role or the profile never names.

    - company, title and dates come from the matching profile role;
    - ``used_skills`` keeps only items that role's text or Project Evidence mentions;
    - ``technical_skills`` keeps only items the profile or evidence mentions anywhere.
    Bullets are left alone: they need a rewrite, which ``unattributed_role_terms`` reports.
    """
    if not resume or not isinstance(resume, dict):
        return resume
    roles = parse_profile_roles(profile_text)
    if not roles:
        return resume
    texts = role_evidence_texts(roles, evidence_text)
    entries = [e for e in resume.get("work_experience") or [] if isinstance(e, dict)]
    for entry, idx in zip(entries, _match_roles(entries, roles)):
        if idx is None:
            continue
        role = roles[idx]
        entry["company_name"] = role.company or entry.get("company_name")
        if role.title:
            entry["job_title"] = role.title
        if role.period_start:
            entry["period_start"] = role.period_start
            entry["period_end"] = role.period_end or None
        raw = entry.get("used_skills")
        if isinstance(raw, str) and raw.strip():
            kept = [s for s in split_skill_items(raw) if is_mentioned(s, texts[idx])]
            entry["used_skills"] = ", ".join(dict.fromkeys(kept)) or None

    source = "\n".join([profile_text or "", evidence_text or ""])
    skills: list[dict] = []
    for row in resume.get("technical_skills") or []:
        if not isinstance(row, dict):
            continue
        items = [s for s in split_skill_items(str(row.get("skills") or "")) if is_mentioned(s, source)]
        if items:
            skills.append({**row, "skills": ", ".join(dict.fromkeys(items))})
    if skills:
        resume["technical_skills"] = skills
    return resume


def expand_acronyms_once(resume: dict | None, terms: list[str]) -> dict | None:
    """Write "Amazon Web Services (AWS)" at the first standalone use of each supported acronym.

    Recruiter search is literal, so a resume should carry both forms once. Uses inside a
    product name ("AWS SageMaker", "AWS-native") are left alone.
    """
    if not resume or not isinstance(resume, dict):
        return resume
    entries = [e for e in resume.get("work_experience") or [] if isinstance(e, dict)]
    blob = _norm("\n".join([str(resume.get("profile_summary") or "")] + [b for e in entries for b in e.get("bullets") or [] if isinstance(b, str)]))
    for term in dict.fromkeys(terms or []):
        long_form = _EXPANSIONS.get(term.lower())
        if not long_form or _norm(long_form) in blob:
            continue
        pattern = re.compile(
            r"(?<![\w(./*-])(\*\*)?" + re.escape(term) + r"(?(1)\*\*)(?![\w)/*-])(?!\s+[A-Z])"
        )

        def _expand(text: str) -> tuple[str, bool]:
            m = pattern.search(text)
            if not m:
                return text, False
            bold = m.group(1) or ""
            return text[: m.start()] + f"{bold}{long_form} ({term}){bold}" + text[m.end():], True

        summary, done = _expand(str(resume.get("profile_summary") or ""))
        if done:
            resume["profile_summary"] = summary
        else:
            for entry in entries:
                bullets = entry.get("bullets") or []
                for i, b in enumerate(bullets):
                    if isinstance(b, str):
                        new, done = _expand(b)
                        if done:
                            bullets[i] = new
                            break
                if done:
                    break
        if done:
            blob += " " + _norm(long_form)
    return resume


def cap_skills_section(skills: list[dict], job_text: str, *, limit: int = 30) -> list[dict]:
    """Trim technical_skills to *limit* items; items the posting names always stay.

    Each step drops the last unnamed item of the category with the most of them, so a
    bloated category shrinks before a short one loses anything.
    """
    rows = [
        (dict(r), [s.strip() for s in str(r.get("skills") or "").split(",") if s.strip()])
        for r in skills or []
        if isinstance(r, dict)
    ]
    total = sum(len(items) for _, items in rows)
    while total > limit:
        droppable = [[i for i in items if not is_mentioned(i, job_text)] for _, items in rows]
        pick = max(range(len(rows)), key=lambda k: (len(droppable[k]), k), default=None)
        if pick is None or not droppable[pick]:
            break
        rows[pick][1].remove(droppable[pick][-1])
        total -= 1
    return [{**row, "skills": ", ".join(items)} for row, items in rows if items]


def unattributed_role_terms(
    resume: dict | None,
    profile_text: str,
    evidence_text: str = "",
    extra_terms: list[str] | None = None,
) -> dict[int, list[str]]:
    """Named technologies a tailored role's bullets or description claim without role evidence.

    Keyed by tailored work_experience index. Candidates are the profile's global skills
    plus *extra_terms* (job anchors): the two places a model borrows technologies from.
    """
    if not resume or not isinstance(resume, dict):
        return {}
    roles = parse_profile_roles(profile_text)
    if not roles:
        return {}
    texts = role_evidence_texts(roles, evidence_text)
    candidates = [
        t for t in parse_profile_skills(profile_text) + list(extra_terms or []) if is_named_technology(t)
    ]
    entries = [e for e in resume.get("work_experience") or [] if isinstance(e, dict)]
    out: dict[int, list[str]] = {}
    for pos, (entry, idx) in enumerate(zip(entries, _match_roles(entries, roles))):
        if idx is None:
            continue
        claimed = "\n".join(
            [str(entry.get("project_description") or "")]
            + [b for b in entry.get("bullets") or [] if isinstance(b, str)]
        )
        bad: list[str] = []
        seen: set[str] = set()
        for term in candidates:
            key = _norm(term)
            if key in seen:
                continue
            seen.add(key)
            if is_mentioned(term, claimed) and not is_mentioned(term, texts[idx]):
                bad.append(term)
        if bad:
            out[pos] = bad
    return out


def summary_unattributed_terms(
    resume: dict | None,
    profile_text: str,
    evidence_text: str = "",
    extra_terms: list[str] | None = None,
) -> list[str]:
    """Named technologies the summary claims that no dated role (or its evidence) names."""
    if not resume or not isinstance(resume, dict):
        return []
    roles = parse_profile_roles(profile_text)
    if not roles:
        return []
    texts = role_evidence_texts(roles, evidence_text)
    summary = str(resume.get("profile_summary") or "")
    bad: list[str] = []
    seen: set[str] = set()
    for term in parse_profile_skills(profile_text) + list(extra_terms or []):
        key = _norm(term)
        if key in seen or not is_named_technology(term):
            continue
        seen.add(key)
        if is_mentioned(term, summary) and not any(is_mentioned(term, t) for t in texts):
            bad.append(term)
    return bad


def build_role_evidence_block(
    profile_text: str,
    evidence_text: str = "",
    job_terms: list[str] | None = None,
) -> str:
    """Per-role list of technologies the role may name, plus skills with no role evidence."""
    roles = parse_profile_roles(profile_text)
    if not roles:
        return "No structured work history found; use only technologies the profile ties to each role."
    texts = role_evidence_texts(roles, evidence_text)
    lines: list[str] = []
    attributed: set[str] = set()
    for i, (role, text) in enumerate(zip(roles, texts)):
        terms = role_terms(text, _role_candidates(profile_text, role, job_terms or []))
        attributed.update(_norm(t) for t in terms)
        period = " - ".join(p for p in (role.period_start, role.period_end or "Present") if p)
        lines.append(f"- [{i}] {role.company} | {role.title} | {period}: {', '.join(terms) or '(none named)'}")
    loose = [
        s for s in parse_profile_skills(profile_text)
        if _norm(s) not in attributed and not any(is_mentioned(s, t) for t in texts)
    ]
    if loose:
        lines.append(
            "- Skills list only (no role names them; technical_skills only, never in a role): "
            + ", ".join(loose[:40])
        )
    return "\n".join(lines)


def build_source_facts_block(profile_text: str, evidence_text: str = "", *, limit: int = 16) -> str:
    """Profile lines a tailored resume must keep: numbers and scale, then leadership and quality evidence."""
    roles = parse_profile_roles(profile_text)
    texts = role_evidence_texts(roles, evidence_text) if roles else []
    metrics: list[str] = []
    per_role_signals: list[list[str]] = []
    for role, text in zip(roles, texts):
        signals: list[str] = []
        for line in text.splitlines():
            s = line.strip().lstrip("-*\u2022 ").strip()
            low = s.lower()
            if len(s) < 20 or low.startswith(("technologies:", "project:")):
                continue
            fact = f"- [{role.company}] {s[:240]}"
            if _METRIC_RE.search(s) or any(w in low for w in _SCALE_WORDS):
                metrics.append(fact)
            elif _SIGNAL_RE.search(s):
                signals.append(fact)
        per_role_signals.append(signals)
    facts = metrics[: limit // 2]
    # Round-robin so every role keeps its leadership and quality evidence, not just the newest one.
    depth = max((len(s) for s in per_role_signals), default=0)
    for i in range(depth):
        facts.extend(s[i] for s in per_role_signals if i < len(s))
    facts = facts[:limit]
    if not facts:
        return "- None stated. Describe scope and outcomes qualitatively; never invent numbers."
    return "\n".join(facts)


def build_supported_terms_block(
    terms: list[str],
    profile_text: str,
    evidence_text: str = "",
    *,
    limit: int = 24,
) -> str:
    """Where each supported job term is evidenced: named roles, or the skills list only."""
    roles = parse_profile_roles(profile_text)
    texts = role_evidence_texts(roles, evidence_text) if roles else []
    lines: list[str] = []
    seen: set[str] = set()
    for term in terms:
        key = _norm(term)
        if not key or key in seen:
            continue
        seen.add(key)
        where = [r.company for r, t in zip(roles, texts) if is_mentioned(term, t)]
        line = f"- {term}: " + (", ".join(where) if where else "skills list or summary only")
        long_form = _EXPANSIONS.get(key)
        if long_form and long_form.lower() != key:
            line += f" (spell out once: {long_form} ({term}))"
        lines.append(line)
        if len(lines) >= limit:
            break
    return "\n".join(lines) if lines else "- (No job terms matched the profile.)"


def copied_job_phrases(resume: dict | None, job_text: str, *, n: int = 8) -> list[str]:
    """Runs of *n* or more words the resume prose shares with the posting."""
    if not resume or not isinstance(resume, dict) or not job_text:
        return []

    def _tokens(s: str) -> list[str]:
        return re.findall(r"[a-z0-9][a-z0-9+#.]*", _norm(s))

    jd = _tokens(job_text)
    grams = {tuple(jd[i:i + n]) for i in range(len(jd) - n + 1)}
    prose = [str(resume.get("profile_summary") or "")]
    for entry in resume.get("work_experience") or []:
        if isinstance(entry, dict):
            prose.append(str(entry.get("project_description") or ""))
            prose.extend(b for b in entry.get("bullets") or [] if isinstance(b, str))
    found: list[str] = []
    for text in prose:
        toks = _tokens(text)
        i = 0
        while i <= len(toks) - n:
            if tuple(toks[i:i + n]) in grams:
                j = i + n
                while j < len(toks) and tuple(toks[j - n + 1:j + 1]) in grams:
                    j += 1
                found.append(" ".join(toks[i:j]))
                i = j
            else:
                i += 1
    return list(dict.fromkeys(found))
