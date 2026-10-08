"""Year each technology became generally usable, so a role never claims one before it existed.

Years are the first stable public release (or general availability for managed
services). A role may name a technology released before the year it ended; a
current role may name anything released by now. Terms not listed have no limit.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from app.utils.resume_evidence import _ALIASES, _norm

INTRO_YEAR: dict[str, int] = {
    # AI and machine learning
    "llm": 2020, "large language model": 2020, "generative ai": 2020, "openai": 2020, "openai api": 2020,
    "gpt": 2020, "gpt-3": 2020, "gpt-4": 2023, "chatgpt": 2022, "claude": 2023, "anthropic": 2023,
    "llama": 2023, "gemini": 2023, "mistral": 2023, "langchain": 2022, "llamaindex": 2022, "langgraph": 2024,
    "langsmith": 2023, "crewai": 2024, "autogen": 2023, "dspy": 2023, "model context protocol": 2024,
    "mcp": 2024, "rag": 2020, "prompt engineering": 2020, "ai agents": 2023, "agentic ai": 2023,
    "vllm": 2023, "bedrock": 2023, "amazon bedrock": 2023, "azure openai": 2023, "vertex ai": 2021,
    "pgvector": 2021, "pinecone": 2021, "weaviate": 2019, "qdrant": 2021, "chroma": 2023, "milvus": 2019,
    "vector database": 2020, "vector search": 2019, "hugging face": 2019, "transformers": 2019, "bert": 2018,
    "pytorch": 2016, "tensorflow": 2015, "keras": 2015, "jax": 2018, "mlflow": 2018, "kubeflow": 2018,
    "sagemaker": 2017, "ray": 2017, "onnx": 2017, "triton": 2019, "xgboost": 2014, "lightgbm": 2017,
    "scikit learn": 2010, "pandas": 2008, "numpy": 2006, "polars": 2021, "mlops": 2018,
    # Data
    "spark": 2014, "kafka": 2011, "flink": 2015, "airflow": 2015, "dbt": 2017, "iceberg": 2018,
    "delta lake": 2019, "hudi": 2019, "dagster": 2019, "prefect": 2018, "beam": 2016, "snowflake": 2015,
    "databricks": 2015, "redshift": 2013, "bigquery": 2011, "kinesis": 2013, "data lakehouse": 2020,
    "fivetran": 2013, "looker": 2012, "power bi": 2015, "tableau": 2005, "duckdb": 2019, "trino": 2019,
    "presto": 2013,
    # Cloud
    "aws": 2006, "azure": 2010, "gcp": 2011, "lambda": 2014, "serverless": 2014, "ecs": 2015,
    "fargate": 2017, "eks": 2018, "aks": 2018, "gke": 2015, "cloud run": 2019, "azure functions": 2016,
    "dynamodb": 2012, "aurora": 2015, "cloudformation": 2011, "step functions": 2016, "eventbridge": 2019,
    "vercel": 2016, "cloudflare workers": 2018, "supabase": 2020, "firestore": 2017,
    # DevOps
    "docker": 2013, "kubernetes": 2015, "terraform": 2014, "pulumi": 2018, "helm": 2016,
    "service mesh": 2017, "istio": 2017, "argocd": 2018, "github actions": 2019, "gitlab ci": 2012,
    "circleci": 2011, "prometheus": 2015, "grafana": 2014, "opentelemetry": 2019, "datadog": 2010,
    "ansible": 2012, "infrastructure as code": 2011, "vault": 2015, "backstage": 2020,
    # Databases
    "mongodb": 2009, "redis": 2009, "elasticsearch": 2010, "opensearch": 2021, "cassandra": 2008,
    "neo4j": 2010, "influxdb": 2013, "clickhouse": 2016, "cockroachdb": 2017, "prisma": 2019,
    "typeorm": 2016, "timescaledb": 2017,
    # Languages and runtimes
    "typescript": 2012, "go": 2009, "golang": 2009, "rust": 2015, "kotlin": 2016, "swift": 2014,
    "dart": 2011, "elixir": 2012, "julia": 2012, "zig": 2016, "node.js": 2009, "deno": 2020, "bun": 2022,
    "graphql": 2015, "grpc": 2016, "webassembly": 2017, "wasm": 2017,
    # Frameworks
    "react": 2013, "react native": 2015, "angular": 2010, "vue": 2014, "svelte": 2016, "next.js": 2016,
    "nuxt": 2016, "remix": 2021, "astro": 2021, "redux": 2015, "zustand": 2019, "vite": 2020,
    "tailwind css": 2017, "storybook": 2016, "flutter": 2017, "swiftui": 2019, "jetpack compose": 2021,
    "express": 2010, "nestjs": 2017, "fastify": 2016, "fastapi": 2018, "flask": 2010, "django": 2005,
    "spring boot": 2014, ".net core": 2016, "temporal": 2020, "celery": 2009, "websockets": 2011,
    "jwt": 2012, "oauth": 2010, "openid connect": 2014,
    # Testing
    "playwright": 2020, "cypress": 2017, "jest": 2014, "vitest": 2022, "pytest": 2010, "k6": 2017,
    "testcontainers": 2015,
}

_YEAR_RE = re.compile(r"\b(19|20)\d{2}\b")


def current_year() -> int:
    return datetime.now(timezone.utc).year


def intro_year(term: str) -> int | None:
    """Release year of *term* (or a known alias), None when unknown."""
    key = _norm(re.sub(r"\([^)]*\)", " ", term or ""))
    if not key:
        return None
    if key in INTRO_YEAR:
        return INTRO_YEAR[key]
    for alias in _ALIASES.get(key, ()):
        if alias in INTRO_YEAR:
            return INTRO_YEAR[alias]
    if key.endswith("s") and key[:-1] in INTRO_YEAR:
        return INTRO_YEAR[key[:-1]]
    from app.services.required_skills import lexicon_hits

    hits = lexicon_hits(term)
    if hits and _norm(hits[0][1]) == key:
        return INTRO_YEAR.get(hits[0][0])
    return None


def period_year(period: str) -> int | None:
    m = _YEAR_RE.search(period or "")
    return int(m.group(0)) if m else None


_MONTHS = {m: i for i, m in enumerate(
    ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), start=1
)}
_NUMERIC_MONTH_RE = re.compile(r"\b(\d{1,2})\s*[/.-]\s*((?:19|20)\d{2})\b|\b((?:19|20)\d{2})\s*[/.-]\s*(\d{1,2})\b")


def period_month_index(period: str | None, *, is_end: bool = False) -> int | None:
    """year * 12 + month (0-based) for "Mar 2021", "03/2021", "2021-03" or "2021"; None when undated.

    A bare year counts as January for a start and December for an end; an empty end is now.
    """
    text = (period or "").strip()
    if not text or text.lower() in ("present", "current", "now", "today"):
        if not is_end:
            return None
        now = datetime.now(timezone.utc)
        return now.year * 12 + now.month - 1
    year = period_year(text)
    if year is None:
        return None
    month = None
    m = _NUMERIC_MONTH_RE.search(text)
    if m:
        month = int(m.group(1) or m.group(4))
    else:
        word = re.search(r"[A-Za-z]{3,}", text)
        if word:
            month = _MONTHS.get(word.group(0)[:3].lower())
    if not month or not 1 <= month <= 12:
        month = 12 if is_end else 1
    return year * 12 + month - 1


def usable_in_role(term: str, end_year: int | None, *, is_current: bool) -> bool:
    """True when *term* existed while the role ran (released before its last year)."""
    year = intro_year(term)
    if year is None or end_year is None:
        return True
    if is_current:
        return year <= current_year()
    return year < end_year
