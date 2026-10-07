"""Deterministic clean-up of tailored resume formatting.

The tailoring prompt asks for clean single-concept skill categories, plain skill lists
and sparse bold. Models still drift ("Frontend & Libraries", "**React**,**Vue**",
eight bold spans in one bullet), so every tailored resume passes through
:func:`normalize_tailored_formatting` before it is stored or rendered.
"""

from __future__ import annotations

import re

_BOLD_SPAN_RE = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)
# "**BrightLane** **Market**" is one name split in two; render it as one span.
_ADJACENT_BOLD_RE = re.compile(r"\*\*([^*]+)\*\*([ \t]+)\*\*([^*]+)\*\*")
_ITEM_SPLIT_RE = re.compile(r"\s*[,;|\n\u00b7\u2022]+\s*")
# Split compound category names on "&", "and", "+" and spaced slashes. "CI/CD" and
# "AI/ML" keep their unspaced slash.
_CATEGORY_JOIN_RE = re.compile(r"\s*(?:&|\+|\band\b|\s/\s|,)\s*", re.IGNORECASE)

# Words that never carry meaning in a category name on their own.
_FILLER_PARTS = frozenset(
    {
        "libraries", "library", "frameworks", "framework", "apis", "api", "storage",
        "tools", "tooling", "tool", "platforms", "platform", "services", "service",
        "technologies", "technology", "tech", "systems", "ecosystem", "stack",
        "utilities", "misc", "others", "other", "solutions", "software",
    }
)

_GENERIC_NAMES = frozenset(
    {
        "skills", "technical skills", "other", "others", "miscellaneous", "misc",
        "general", "core", "core skills", "soft skills", "additional", "additional skills",
    }
)

# Canonical spelling for common category names (lower-case key).
_CANONICAL_NAMES: dict[str, str] = {
    "front end": "Frontend",
    "front-end": "Frontend",
    "frontend": "Frontend",
    "frontend development": "Frontend",
    "ui": "Frontend",
    "back end": "Backend",
    "back-end": "Backend",
    "backend": "Backend",
    "backend development": "Backend",
    "server side": "Backend",
    "server-side": "Backend",
    "programming languages": "Languages",
    "programming": "Languages",
    "languages": "Languages",
    "language": "Languages",
    "database": "Databases",
    "databases": "Databases",
    "data stores": "Databases",
    "datastores": "Databases",
    "cloud": "Cloud",
    "cloud computing": "Cloud",
    "cloud platforms": "Cloud",
    "devops": "DevOps",
    "dev ops": "DevOps",
    "ci/cd": "CI/CD",
    "ci cd": "CI/CD",
    "testing": "Testing",
    "testing & qa": "Testing",
    "qa": "Testing",
    "quality assurance": "Testing",
    "messaging": "Messaging",
    "message queues": "Messaging",
    "streaming": "Streaming",
    "monitoring": "Observability",
    "observability": "Observability",
    "ml": "Machine Learning",
    "machine learning": "Machine Learning",
    "ai/ml": "Machine Learning",
    "ml/ai": "Machine Learning",
    "llm": "LLMs",
    "llms": "LLMs",
    "mobile": "Mobile",
    "infrastructure": "Infrastructure",
    "iac": "Infrastructure as Code",
    "containers": "Containers",
    "containerization": "Containers",
    "security": "Security",
    "data": "Data",
}

# When both parts survive, a broad part absorbs a narrower one ("DevOps & CI/CD" -> "DevOps").
_ABSORBS: dict[str, frozenset[str]] = {
    "DevOps": frozenset({"CI/CD", "Infrastructure", "Containers", "Automation", "Deployment"}),
    "Cloud": frozenset({"Infrastructure", "Hosting"}),
    "Backend": frozenset({"Microservices", "Server", "Web Services", "Rest", "Graphql"}),
    "Frontend": frozenset({"UI", "Ui", "Web", "Styling", "State Management"}),
    "Databases": frozenset({"Caching", "Data", "Sql", "Nosql", "Orm"}),
    "Machine Learning": frozenset({"AI", "Ai", "Data Science"}),
    "Testing": frozenset({"QA", "Qa", "Quality"}),
    "Observability": frozenset({"Monitoring", "Logging"}),
}

_SMALL_WORDS = frozenset({"as", "of", "and", "for", "in", "on", "to"})


def strip_bold_markers(text: str) -> str:
    return (text or "").replace("**", "")


def normalize_skill_list(raw: str) -> str:
    """Plain, de-duplicated items joined with ", " ("A,B ; **C**" -> "A, B, C")."""
    items: list[str] = []
    seen: set[str] = set()
    for part in _ITEM_SPLIT_RE.split(strip_bold_markers(raw)):
        item = part.strip(" \t").rstrip(".").strip()
        if not item:
            continue
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        items.append(item)
    return ", ".join(items)


def _title_part(part: str) -> str:
    words = part.split()
    out: list[str] = []
    for i, w in enumerate(words):
        if any(ch.isupper() for ch in w[1:]) or "/" in w or "." in w:
            out.append(w)  # keep DevOps, CI/CD, Node.js as written
        elif i > 0 and w.lower() in _SMALL_WORDS:
            out.append(w.lower())
        else:
            out.append(w[:1].upper() + w[1:])
    return " ".join(out)


def _canonical_part(part: str) -> str:
    cleaned = re.sub(r"\s+", " ", part.strip(" -:()")).strip()
    if not cleaned:
        return ""
    key = cleaned.lower()
    if key in _CANONICAL_NAMES:
        return _CANONICAL_NAMES[key]
    if key in _FILLER_PARTS:
        return ""
    # Drop trailing filler only when a known name remains ("Cloud Platforms" -> "Cloud",
    # "Frontend Libraries" -> "Frontend"); "Build Tools" stays as written.
    words = cleaned.split()
    while len(words) > 1 and words[-1].lower() in _FILLER_PARTS:
        words.pop()
        trimmed = " ".join(words).lower()
        if trimmed in _CANONICAL_NAMES:
            return _CANONICAL_NAMES[trimmed]
    return _title_part(cleaned)


def category_parts(name: str) -> list[str]:
    """Meaningful canonical parts of a category name, filler and absorbed parts removed."""
    raw = strip_bold_markers(name).strip().rstrip(":")
    if not raw:
        return []
    parts: list[str] = []
    for x in _CATEGORY_JOIN_RE.split(raw):
        p = _canonical_part(x)
        if p and p.lower() not in {q.lower() for q in parts}:
            parts.append(p)
    if len(parts) >= 2:
        kept = [
            p for p in parts
            if not any(p in _ABSORBS.get(other, frozenset()) for other in parts if other != p)
        ]
        parts = kept or parts
    if not parts:
        return [_title_part(raw)]
    return parts


def normalize_skill_category(name: str) -> str:
    """Clean, professional category name: "Frontend & Libraries" -> "Frontend",
    "Database & Storage" -> "Databases", "DevOps & CI/CD" -> "DevOps"."""
    parts = category_parts(name)
    return " & ".join(parts[:2]) if parts else ""


# Recognisable technologies per category, used to split a compound category
# ("Cloud & DevOps") into its single-concept parts. Matched case-insensitively
# against the start of each item.
_LEXICON: dict[str, tuple[str, ...]] = {
    "Cloud": (
        "aws", "amazon", "azure", "gcp", "google cloud", "lambda", "s3", "ec2", "ecs", "eks",
        "cloudfront", "dynamodb", "sqs", "sns", "rds", "cloud run", "bigquery", "firebase",
        "heroku", "vercel", "netlify", "digitalocean", "cloudflare", "oci", "ibm cloud",
    ),
    "DevOps": (
        "docker", "kubernetes", "k8s", "helm", "terraform", "ansible", "pulumi", "jenkins",
        "github actions", "gitlab", "circleci", "argo", "ci/cd", "travis", "bitbucket pipelines",
        "chef", "puppet", "nginx", "linux", "bash", "openshift", "istio", "packer", "vault",
    ),
    "Databases": (
        "postgres", "mysql", "mariadb", "mongodb", "redis", "sqlite", "oracle", "sql server",
        "mssql", "cassandra", "dynamodb", "elasticsearch", "opensearch", "neo4j", "couchbase",
        "cockroach", "supabase", "snowflake", "clickhouse", "memcached", "prisma", "sqlalchemy",
        "hibernate", "typeorm", "sequelize", "pinecone", "pgvector", "weaviate", "milvus",
        "cosmos", "azure cosmos", "azure sql", "timescale", "influx", "amazon timestream", "amazon rds",
        "aurora", "bigtable", "firestore", "spanner",
    ),
    "Messaging": ("kafka", "rabbitmq", "sqs", "sns", "pub/sub", "nats", "activemq", "kinesis", "celery", "zeromq"),
    "Observability": (
        "datadog", "prometheus", "grafana", "new relic", "splunk", "sentry", "elk", "kibana",
        "opentelemetry", "jaeger", "cloudwatch", "pagerduty", "loki", "honeycomb",
    ),
    "Testing": (
        "jest", "vitest", "mocha", "cypress", "playwright", "selenium", "pytest", "junit",
        "testng", "rspec", "testing library", "enzyme", "postman", "k6", "jmeter", "cucumber",
    ),
    "Frontend": (
        "react", "next.js", "vue", "nuxt", "angular", "svelte", "redux", "tailwind", "html",
        "css", "sass", "webpack", "vite", "jquery", "material ui", "mui", "bootstrap",
        "storybook", "zustand", "react query", "chakra",
    ),
    "Backend": (
        "node", "express", "nestjs", "django", "flask", "fastapi", "spring", "rails", ".net",
        "asp.net", "laravel", "graphql", "rest", "grpc", "gin", "fiber", "koa", "hapi", "phoenix",
    ),
    "Languages": (
        "python", "javascript", "typescript", "java", "go", "golang", "rust", "c#", "c++",
        "ruby", "php", "kotlin", "swift", "scala", "sql", "r", "dart", "elixir", "bash",
    ),
}


def _lexicon_home(item: str, candidates: list[str]) -> str | None:
    low = item.lower()
    for cat in candidates:
        for term in _LEXICON.get(cat, ()):
            if low == term or low.startswith(term + " ") or low.startswith(term):
                if len(term) <= 2 and low != term:
                    continue  # "r", "go" must match exactly
                return cat
    return None


def rehome_misplaced_skills(skills: list[dict]) -> list[dict]:
    """Move an item the lexicon places elsewhere ("Node.js" under Languages) into that category.

    Only moves into a category the section already has, and only when the item does not
    also belong where it is (DynamoDB stays under Databases or Cloud).
    """
    rows = [dict(r) for r in skills or [] if isinstance(r, dict)]
    names = [str(r.get("category") or "") for r in rows]
    known = [n for n in names if n in _LEXICON]
    buckets = [[i for i in normalize_skill_list(str(r.get("skills") or "")).split(", ") if i] for r in rows]
    moves: dict[int, list[str]] = {}
    for idx, (name, items) in enumerate(zip(names, buckets)):
        if name not in _LEXICON:
            continue
        keep: list[str] = []
        for item in items:
            others = [n for n in known if n != name]
            home = None if _lexicon_home(item, [name]) else _lexicon_home(item, others)
            if home:
                moves.setdefault(names.index(home), []).append(item)
            else:
                keep.append(item)
        buckets[idx] = keep
    for idx, items in moves.items():
        buckets[idx] = buckets[idx] + [i for i in items if i not in buckets[idx]]
    return [{**r, "skills": ", ".join(b)} for r, b in zip(rows, buckets) if b]


def _split_compound(parts: list[str], items: list[str]) -> list[tuple[str, list[str]]]:
    """Distribute *items* across *parts* by lexicon; unmatched items stay with the first part."""
    buckets: dict[str, list[str]] = {p: [] for p in parts}
    for item in items:
        home = _lexicon_home(item, parts) or parts[0]
        buckets[home].append(item)
    return [(p, buckets[p]) for p in parts if buckets[p]]


def normalize_skill_categories(skills: list[dict]) -> list[dict]:
    """Canonical names, compound categories split, duplicates merged, each technology once."""
    merged: dict[str, list[str]] = {}
    order: list[str] = []
    seen_items: set[str] = set()
    pending_generic: list[str] = []

    def _put(cat: str, items: list[str]) -> None:
        key = cat.lower()
        if key not in merged:
            merged[key] = []
            order.append(cat)
        merged[key].extend(items)

    for row in skills or []:
        if not isinstance(row, dict):
            continue
        parts = category_parts(str(row.get("category") or ""))
        items = [i for i in normalize_skill_list(str(row.get("skills") or "")).split(", ") if i]
        fresh = []
        for item in items:
            key = item.lower()
            if key in seen_items:
                continue
            seen_items.add(key)
            fresh.append(item)
        if not fresh:
            continue
        if not parts or parts[0].lower() in _GENERIC_NAMES:
            pending_generic.extend(fresh)
            continue
        if len(parts) == 1:
            _put(parts[0], fresh)
            continue
        for cat, bucket in _split_compound(parts, fresh):
            _put(cat, bucket)
    out = [{"category": cat, "skills": ", ".join(merged[cat.lower()])} for cat in order]
    if pending_generic:
        key = "tools"
        if key in merged:
            merged[key].extend(pending_generic)
            out = [{"category": cat, "skills": ", ".join(merged[cat.lower()])} for cat in order]
        else:
            out.append({"category": "Tools", "skills": ", ".join(pending_generic)})
    return out


# Words that read as noise when bold, whatever their case ("**Key** results").
_COMMON_WORDS = frozenset(
    """
    key data team teams project projects work level mode lab tests test testing development stack
    system systems platform platforms service services policy policies security quality analytics
    automation engineering engineer product products process processes support customer customers
    business users user performance reliability scale scalable design delivery features feature
    tools tooling solutions application applications code reporting report reports operations
    infrastructure integration integrations documentation monitoring workflows workflow pipeline
    pipelines model models modeling api apis web mobile backend frontend cloud devices device
    management strategy requirements standards experience new improved high low end real time
    """.split()
)


def is_strong_emphasis_term(term: str) -> bool:
    """A term worth bolding: a named technology or a figure, not a common word.

    "Kafka", "AWS", "Node.js", "40%" and "Security Hub" qualify; "key", "data" and
    "Testing" do not.
    """
    t = strip_bold_markers(term).strip()
    if len(t) < 2 or t.lower() in _COMMON_WORDS:
        return False
    tokens = t.split()
    for tok in tokens:
        if tok.lower() in _COMMON_WORDS:
            continue
        if any(ch.isdigit() for ch in tok) or any(ch in ".+#/%$" for ch in tok):
            return True
        if any(ch.isupper() for ch in tok):
            return True
    return False


def cap_bold_spans(text: str, max_spans: int) -> str:
    """Unwrap low-value ``**bold**`` spans, then keep the first *max_spans* of the rest."""
    if not text or "**" not in text:
        return text or ""
    text = _ADJACENT_BOLD_RE.sub(r"**\1\2\3**", text)
    count = 0

    def _keep(m: re.Match[str]) -> str:
        nonlocal count
        if not is_strong_emphasis_term(m.group(1)):
            return m.group(1)
        count += 1
        return m.group(0) if count <= max_spans else m.group(1)

    out = _BOLD_SPAN_RE.sub(_keep, text)
    # A dangling unmatched "**" would render literally; drop it.
    if out.count("**") % 2 == 1:
        idx = out.rfind("**")
        out = out[:idx] + out[idx + 2:]
    return out


MAX_BOLD_PER_BULLET = 2
MAX_BOLD_IN_SUMMARY = 4
MAX_BOLD_IN_DESCRIPTION = 2


def normalize_tailored_formatting(resume: dict | None) -> dict | None:
    """Apply the formatting contract to a parsed tailored resume (returns a copy)."""
    if not resume or not isinstance(resume, dict):
        return resume
    out = dict(resume)
    if isinstance(out.get("profile_summary"), str):
        out["profile_summary"] = cap_bold_spans(out["profile_summary"], MAX_BOLD_IN_SUMMARY)
    if isinstance(out.get("technical_skills"), list):
        out["technical_skills"] = normalize_skill_categories(out["technical_skills"])
    exp_out: list[dict] = []
    for entry in out.get("work_experience") or []:
        if not isinstance(entry, dict):
            continue
        row = dict(entry)
        if isinstance(row.get("used_skills"), str):
            row["used_skills"] = normalize_skill_list(row["used_skills"]) or None
        if isinstance(row.get("project_description"), str):
            row["project_description"] = cap_bold_spans(row["project_description"], MAX_BOLD_IN_DESCRIPTION)
        row["bullets"] = [
            cap_bold_spans(b, MAX_BOLD_PER_BULLET)
            for b in (row.get("bullets") or [])
            if isinstance(b, str) and b.strip()
        ]
        exp_out.append(row)
    if "work_experience" in out:
        out["work_experience"] = exp_out
    return out
