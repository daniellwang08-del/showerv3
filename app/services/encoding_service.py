"""Once-per-job / once-per-profile encoding for the non-LLM match engine.

Embeddings are computed with a CPU sentence-transformers model that is loaded
lazily and only in the process that actually encodes (the ``encoding`` arq
worker and the backfill task). Scoring processes (analysis worker) never load
the model — they read stored float32 vectors and do pure numpy math.

Storage format: L2-normalized float32 arrays as raw bytes, so cosine
similarity is a dot product.
"""

from __future__ import annotations

import base64
import hashlib
import re
from datetime import datetime, timezone

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import undefer

from app.core.config import get_settings
from app.core.logging import get_logger
from app.models.database import Job, JobEncoding, JobExtraction, User, UserEncoding
from app.services.security_clearance_detector import requires_security_clearance
from app.services.skill_lexicon import extract_skills, extract_skills_with_importance
from app.storage.database import get_session

logger = get_logger(__name__)

_model = None

# Sentence-transformers truncates inputs to the model's max sequence length
# (~384 tokens for all-mpnet-base-v2), so we front-load informative content
# and cap raw characters to keep tokenization cheap.
_MAX_EMBED_CHARS = 3000


def get_embedding_model():
    """Lazy singleton. Heavy import stays out of non-encoding processes."""
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer

        settings = get_settings()
        logger.info(
            "embedding_model_loading",
            model=settings.embedding_model_name,
            cache_dir=settings.embedding_model_cache_dir,
        )
        _model = SentenceTransformer(
            settings.embedding_model_name,
            cache_folder=settings.embedding_model_cache_dir,
            device="cpu",
        )
        logger.info("embedding_model_loaded", model=settings.embedding_model_name)
    return _model


def model_version() -> str:
    return get_settings().embedding_model_name


def encode_texts(texts: list[str]) -> np.ndarray:
    """Encode texts to L2-normalized float32 vectors (rows)."""
    model = get_embedding_model()
    clipped = [(t or "")[:_MAX_EMBED_CHARS] for t in texts]
    vecs = model.encode(
        clipped,
        batch_size=get_settings().embedding_batch_size,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    return np.asarray(vecs, dtype=np.float32)


def vec_to_bytes(vec: np.ndarray | None) -> bytes | None:
    if vec is None:
        return None
    return np.asarray(vec, dtype=np.float32).tobytes()


def bytes_to_vec(raw: bytes | None) -> np.ndarray | None:
    if not raw:
        return None
    return np.frombuffer(raw, dtype=np.float32)


def vec_to_b64(vec: np.ndarray) -> str:
    return base64.b64encode(np.asarray(vec, dtype=np.float32).tobytes()).decode("ascii")


def b64_to_vec(data: str | None) -> np.ndarray | None:
    if not data:
        return None
    try:
        return np.frombuffer(base64.b64decode(data), dtype=np.float32)
    except Exception:
        return None


# ── Deterministic JD signal extraction ──────────────────────────────────────

_YEARS_RE = re.compile(
    r"(?:at\s+least\s+|minimum\s+(?:of\s+)?)?(\d{1,2})\s*(?:\+|plus)?\s*"
    r"(?:years?|yrs?)(?:\s+of)?\s+(?:[\w\s,/-]{0,40}?)?(?:experience|exp\b)",
    re.IGNORECASE,
)

_DEGREE_RE = re.compile(
    r"\b(?:bachelor(?:'?s)?|master(?:'?s)?|ph\.?d\.?|b\.?sc?\.?|m\.?sc?\.?|"
    r"(?:bs|ms)\s*/\s*(?:ms|phd)|undergraduate\s+degree|graduate\s+degree|"
    r"degree\s+in\s+\w+)\b",
    re.IGNORECASE,
)
_DEGREE_WAIVER_RE = re.compile(
    r"(?:or\s+equivalent(?:\s+(?:practical\s+)?experience)?|"
    r"degree\s+(?:is\s+)?(?:not\s+required|preferred|a\s+plus)|"
    r"no\s+degree\s+(?:required|needed))",
    re.IGNORECASE,
)


def extract_years_required(text: str | None) -> int | None:
    """Highest plausible 'N+ years ... experience' requirement in the JD."""
    if not text:
        return None
    best: int | None = None
    for match in _YEARS_RE.finditer(text):
        try:
            years = int(match.group(1))
        except (TypeError, ValueError):
            continue
        if 1 <= years <= 20 and (best is None or years > best):
            best = years
    return best


def extract_degree_required(text: str | None) -> bool | None:
    """True when a degree is demanded, False when explicitly waived, None unknown."""
    if not text:
        return None
    if not _DEGREE_RE.search(text):
        return None
    if _DEGREE_WAIVER_RE.search(text):
        return False
    return True


_YEAR_TOKEN_RE = re.compile(r"\b(19|20)\d{2}\b")
_PRESENT_RE = re.compile(r"\b(present|current|now|ongoing)\b", re.IGNORECASE)


def _years_from_experience(entries: list) -> float | None:
    """Approximate total years from work-experience period strings."""
    now_year = datetime.now(timezone.utc).year
    spans: list[tuple[int, int]] = []
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        start_raw = str(entry.get("period_start") or "")
        end_raw = str(entry.get("period_end") or "")
        start_years = [int(m.group(0)) for m in _YEAR_TOKEN_RE.finditer(start_raw)]
        if not start_years:
            continue
        start = start_years[0]
        if _PRESENT_RE.search(end_raw) or not end_raw.strip():
            end = now_year
        else:
            end_years = [int(m.group(0)) for m in _YEAR_TOKEN_RE.finditer(end_raw)]
            end = end_years[0] if end_years else now_year
        if start <= end <= now_year + 1:
            spans.append((start, end))
    if not spans:
        return None
    # Merge overlapping spans so concurrent roles are not double counted.
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
    return float(max(total, 0)) or 0.5


# ── Job encoding ────────────────────────────────────────────────────────────

def _compose_job_texts(
    job: Job, extraction: JobExtraction | None, raw_text: str | None
) -> tuple[str, str, str, str]:
    """(title_text, content_text, industry_text, full_text_for_signals)."""
    title = ""
    if extraction is not None and extraction.title:
        title = str(extraction.title)
    elif job.title:
        title = str(job.title)

    parts: list[str] = []
    requirements = list(getattr(extraction, "requirements", None) or []) if extraction else []
    responsibilities = list(getattr(extraction, "responsibilities", None) or []) if extraction else []
    description = (getattr(extraction, "description", None) if extraction else None) or ""

    if title:
        parts.append(title)
    if requirements:
        parts.append("Requirements: " + " ".join(str(r) for r in requirements[:20]))
    if responsibilities:
        parts.append("Responsibilities: " + " ".join(str(r) for r in responsibilities[:15]))
    if description:
        parts.append(description)
    elif raw_text:
        parts.append(raw_text)
    content_text = "\n".join(parts).strip() or (raw_text or "")

    company = ""
    if extraction is not None and extraction.company:
        company = str(extraction.company)
    elif job.company:
        company = str(job.company)
    industry = str(job.industry or "").strip()
    location = ""
    if extraction is not None and extraction.location:
        location = str(extraction.location)
    elif job.location:
        location = str(job.location)
    industry_bits = [
        b for b in (
            f"Company: {company}" if company and company.lower() not in {"unknown", "n/a"} else "",
            f"Industry: {industry}" if industry else "",
            f"Location: {location}" if location else "",
            f"Role family: {title}" if title else "",
        )
        if b
    ]
    industry_text = "\n".join(industry_bits).strip() or (company or title or content_text[:240])

    signal_parts = [content_text]
    if raw_text and raw_text not in content_text:
        signal_parts.append(raw_text)
    full_text = "\n".join(signal_parts)
    return title, content_text, industry_text, full_text


async def encode_job(job_id: str) -> bool:
    """Compute and upsert the JobEncoding row. Returns True on success."""
    async with get_session() as session:
        job = (
            await session.execute(select(Job).where(Job.id == job_id))
        ).scalar_one_or_none()
        if not job:
            logger.warning("encode_job_missing_job", job_id=job_id)
            return False
        extraction = None
        raw_text = None
        if job.extraction_id:
            extraction = (
                await session.execute(
                    select(JobExtraction)
                    .options(undefer(JobExtraction.raw_plain_text))
                    .where(JobExtraction.id == job.extraction_id)
                )
            ).scalar_one_or_none()
            if extraction is not None:
                raw_text = extraction.raw_plain_text

        title_text, content_text, industry_text, full_text = _compose_job_texts(
            job, extraction, raw_text
        )

    if not content_text.strip():
        logger.warning("encode_job_no_text", job_id=job_id)
        return False

    skills = extract_skills_with_importance(full_text)
    years_required = extract_years_required(full_text)
    degree_required = extract_degree_required(full_text)
    clearance, _phrase = requires_security_clearance(full_text)

    vecs = encode_texts(
        [title_text or content_text[:200], content_text, industry_text]
    )
    title_vec, content_vec, industry_vec = vecs[0], vecs[1], vecs[2]

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    async with get_session() as session:
        row = (
            await session.execute(
                select(JobEncoding).where(JobEncoding.job_id == job_id)
            )
        ).scalar_one_or_none()
        if row is None:
            row = JobEncoding(job_id=job_id)
            session.add(row)
        row.model_version = model_version()
        row.title_vec = vec_to_bytes(title_vec)
        row.content_vec = vec_to_bytes(content_vec)
        row.industry_vec = vec_to_bytes(industry_vec)
        row.skills = skills
        row.years_required = years_required
        row.degree_required = degree_required
        row.requires_security_clearance = bool(clearance)
        row.encoded_at = now

    logger.info(
        "job_encoded",
        job_id=job_id,
        skills=len(skills),
        years_required=years_required,
        clearance=clearance,
        industry_chars=len(industry_text),
    )
    return True


# ── User/profile encoding ───────────────────────────────────────────────────

_ROLE_RECENCY_WEIGHTS = (1.0, 1.0, 0.8, 0.6)
_OLD_ROLE_WEIGHT = 0.5
_PROFILE_WIDE_WEIGHT = 0.7
_MAX_TITLE_VECS = 4


def _profile_hash(*chunks: str) -> str:
    digest = hashlib.sha256()
    for chunk in chunks:
        digest.update((chunk or "").encode("utf-8", errors="ignore"))
        digest.update(b"\x00")
    return digest.hexdigest()


def _entry_text(entry: dict) -> str:
    return " ".join(
        str(entry.get(key) or "")
        for key in (
            "job_title", "company_name", "used_skills", "description",
            "project_title", "project_intro", "industry", "location",
        )
    )


def build_prefs_proxy_text(
    *,
    explicit_prefs: str | None,
    guidance: str | None,
    work_experience: list | None,
    country_preferences: list | None,
) -> str:
    """Always-non-empty preferences blob so prefs_vec is never left null."""
    parts: list[str] = []
    if (explicit_prefs or "").strip():
        parts.append(explicit_prefs.strip())
    if (guidance or "").strip():
        parts.append(guidance.strip())

    countries = [str(c).strip().upper() for c in (country_preferences or []) if str(c).strip()]
    if countries:
        parts.append("Preferred work countries: " + ", ".join(countries[:8]))

    titles: list[str] = []
    companies: list[str] = []
    for entry in work_experience or []:
        if not isinstance(entry, dict):
            continue
        title = str(entry.get("job_title") or "").strip()
        company = str(entry.get("company_name") or entry.get("company") or "").strip()
        industry = str(entry.get("industry") or "").strip()
        if title and title not in titles:
            titles.append(title)
        if company and company not in companies:
            companies.append(company)
        if industry:
            parts.append(f"Industry experience: {industry}")
        if len(titles) >= 5:
            break
    if titles:
        parts.append("Target roles similar to: " + "; ".join(titles[:5]))
    if companies:
        parts.append("Companies / domains of interest: " + "; ".join(companies[:6]))

    if not (explicit_prefs or "").strip():
        parts.append(
            "Prefer remote or hybrid roles when the posting allows it; "
            "value strong product and engineering craft, clear ownership, "
            "and modern software delivery practices."
        )
    text = "\n".join(p for p in parts if p).strip()
    return text or "Open to strong engineering roles with clear impact."


def build_domain_proxy_text(work_experience: list | None, education: list | None) -> str:
    """Company / industry narrative for domain-fit embeddings."""
    bits: list[str] = []
    for entry in work_experience or []:
        if not isinstance(entry, dict):
            continue
        company = str(entry.get("company_name") or entry.get("company") or "").strip()
        industry = str(entry.get("industry") or "").strip()
        title = str(entry.get("job_title") or "").strip()
        loc = str(entry.get("location") or "").strip()
        chunk = ", ".join(x for x in (title, company, industry, loc) if x)
        if chunk:
            bits.append(chunk)
    for entry in education or []:
        if not isinstance(entry, dict):
            continue
        school = str(entry.get("school") or entry.get("institution") or "").strip()
        field = str(entry.get("field_of_study") or entry.get("degree") or "").strip()
        chunk = ", ".join(x for x in (field, school) if x)
        if chunk:
            bits.append(chunk)
    return "\n".join(bits[:12]).strip() or "General professional experience"


async def encode_user(user_id: str, *, force: bool = False) -> bool:
    """Compute and upsert the UserEncoding row. Skips when profile unchanged."""
    async with get_session() as session:
        user = (
            await session.execute(
                select(User)
                .options(undefer("*"))
                .where(User.id == user_id)
            )
        ).scalar_one_or_none()
        if not user:
            logger.warning("encode_user_missing_user", user_id=user_id)
            return False

        from app.storage.user_repository import UserRepository

        profile_text = await UserRepository(session).get_profile_openai_text(user_id)
        work_experience = list(user.work_experience or [])
        education = list(user.education or [])
        prefs_text = (user.job_match_preferences or "").strip()
        guidance = ""
        if (user.resume_tailoring_prompt_mode or "default") == "custom":
            guidance = (user.resume_tailoring_prompt_custom or "").strip()
        country_prefs = list(getattr(user, "country_preferences", None) or [])
        prefs_combined = build_prefs_proxy_text(
            explicit_prefs=prefs_text,
            guidance=guidance,
            work_experience=work_experience,
            country_preferences=country_prefs,
        )
        domain_text = build_domain_proxy_text(work_experience, education)

        existing = (
            await session.execute(
                select(UserEncoding).where(UserEncoding.user_id == user_id)
            )
        ).scalar_one_or_none()
        new_hash = _profile_hash(
            profile_text, prefs_combined, domain_text, model_version(), "v2-domain-prefs"
        )
        if (
            not force
            and existing is not None
            and existing.profile_hash == new_hash
            and existing.prefs_vec is not None
            and getattr(existing, "domain_vec", None) is not None
        ):
            logger.info("encode_user_unchanged", user_id=user_id)
            return True

    if not (profile_text or "").strip():
        logger.info("encode_user_no_profile", user_id=user_id)
        return False

    titles: list[str] = []
    for entry in work_experience:
        if isinstance(entry, dict):
            title = str(entry.get("job_title") or "").strip()
            if title:
                titles.append(title)
        if len(titles) >= _MAX_TITLE_VECS:
            break

    skills: dict[str, float] = {}

    def _merge(found: set[str], weight: float) -> None:
        for skill in found:
            skills[skill] = max(skills.get(skill, 0.0), weight)

    for idx, entry in enumerate(work_experience):
        if not isinstance(entry, dict):
            continue
        weight = (
            _ROLE_RECENCY_WEIGHTS[idx]
            if idx < len(_ROLE_RECENCY_WEIGHTS)
            else _OLD_ROLE_WEIGHT
        )
        _merge(extract_skills(_entry_text(entry)), weight)
    _merge(extract_skills(profile_text), _PROFILE_WIDE_WEIGHT)

    years_experience = _years_from_experience(work_experience)
    has_degree = bool(education) or None

    to_encode = [profile_text] + titles + [prefs_combined, domain_text]
    vecs = encode_texts(to_encode)
    experience_vec = vecs[0]
    title_vecs = [
        {"title": titles[i], "vec": vec_to_b64(vecs[1 + i])} for i in range(len(titles))
    ]
    prefs_vec = vecs[1 + len(titles)]
    domain_vec = vecs[2 + len(titles)]

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    async with get_session() as session:
        row = (
            await session.execute(
                select(UserEncoding).where(UserEncoding.user_id == user_id)
            )
        ).scalar_one_or_none()
        if row is None:
            row = UserEncoding(user_id=user_id)
            session.add(row)
        row.model_version = model_version()
        row.experience_vec = vec_to_bytes(experience_vec)
        row.prefs_vec = vec_to_bytes(prefs_vec)
        row.domain_vec = vec_to_bytes(domain_vec)
        row.title_vecs = title_vecs
        row.skills = skills
        row.years_experience = years_experience
        row.has_degree = has_degree
        row.profile_hash = new_hash
        row.encoded_at = now

    logger.info(
        "user_encoded",
        user_id=user_id,
        skills=len(skills),
        titles=len(title_vecs),
        years_experience=years_experience,
        prefs_chars=len(prefs_combined),
        domain_chars=len(domain_text),
    )
    return True
