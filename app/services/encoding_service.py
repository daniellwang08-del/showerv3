"""Once-per-job / once-per-profile encoding for the non-LLM match engine.

Embeddings are computed with a sentence-transformers model that is loaded
lazily and only in the process that actually encodes (the ``encoding`` arq
worker and the backfill task, plus extraction/analysis when inline encoding is
enabled). The device comes from ``EMBEDDING_DEVICE`` (auto | cpu | cuda).
Scoring itself never needs the model, it reads stored float32 vectors and
does pure numpy math.

Storage format: L2-normalized float32 arrays as raw bytes, so cosine
similarity is a dot product.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import queue
import re
import threading
import time
from concurrent.futures import Future
from datetime import datetime, timezone

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import undefer

from app.core.config import get_settings
from app.core.logging import get_logger
from app.models.database import Job, JobEncoding, JobExtraction, User, UserEncoding
from app.services.industry_taxonomy import industry_profile
from app.services.posting_validity import non_posting_reason
from app.services.role_taxonomy import (
    level_from_years,
    role_family,
    role_level,
    role_specialty,
    user_specialties,
)
from app.services.security_clearance_detector import requires_security_clearance
from app.services.skill_lexicon import (
    PREFERRED_HEADING_RE,
    REQUIRED_HEADING_RE,
    extract_skills,
    extract_skills_with_importance,
    skill_category,
)
from app.storage.database import get_session

logger = get_logger(__name__)

# Bump when encode_job / encode_user start writing different inputs for the
# scorer; the backfill re-encodes every row whose encoder_version differs.
ENCODER_VERSION = "v4-roles-industry"

_model = None
_model_device: str | None = None
_model_lock = threading.Lock()

# Sentence-transformers truncates inputs to the model's max sequence length
# (~384 tokens for all-mpnet-base-v2), so we front-load informative content
# and cap raw characters to keep tokenization cheap.
_MAX_EMBED_CHARS = 3000

_CUDA_DEFAULT_BATCH_SIZE = 64
_LOCAL_APP_ENVS = ("local", "dev", "development")


def _cuda_available() -> bool:
    try:
        import torch
    except Exception:
        return False
    try:
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def resolve_embedding_device() -> str:
    """Map EMBEDDING_DEVICE (auto | cpu | cuda) to a usable torch device."""
    requested = get_settings().embedding_device
    if requested == "cpu":
        return "cpu"
    if _cuda_available():
        return "cuda"
    if requested == "cuda":
        logger.warning("embedding_cuda_unavailable_fallback_cpu", requested=requested)
    return "cpu"


def effective_embedding_batch_size(device: str | None = None) -> int:
    """EMBEDDING_BATCH_SIZE when set explicitly, else 64 on CUDA / default on CPU."""
    settings = get_settings()
    if "embedding_batch_size" in settings.model_fields_set:
        return settings.embedding_batch_size
    if (device or _model_device) == "cuda":
        return _CUDA_DEFAULT_BATCH_SIZE
    return settings.embedding_batch_size


def embedding_inline_enabled() -> bool:
    """Whether extraction/analysis may encode in-process instead of enqueueing."""
    settings = get_settings()
    if settings.embedding_inline is not None:
        return settings.embedding_inline
    return settings.app_env.strip().lower() not in _LOCAL_APP_ENVS


def get_embedding_model():
    """Lazy singleton. Heavy import stays out of non-encoding processes."""
    global _model, _model_device
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        from sentence_transformers import SentenceTransformer

        settings = get_settings()
        device = resolve_embedding_device()
        logger.info(
            "embedding_model_loading",
            model=settings.embedding_model_name,
            cache_dir=settings.embedding_model_cache_dir,
            device=device,
        )
        kwargs = {"cache_folder": settings.embedding_model_cache_dir, "device": device}
        try:
            # Cached weights load without Hub round trips (saves 10s+ per start).
            model = SentenceTransformer(settings.embedding_model_name, local_files_only=True, **kwargs)
        except Exception:
            model = SentenceTransformer(settings.embedding_model_name, **kwargs)
        if device == "cuda" and settings.embedding_fp16:
            model.half()
        _model = model
        _model_device = device
        gpu_info: dict = {}
        if device == "cuda":
            try:
                import torch

                props = torch.cuda.get_device_properties(0)
                gpu_info = {
                    "gpu_name": props.name,
                    "gpu_total_vram_mb": int(props.total_memory // (1024 * 1024)),
                }
            except Exception as gpu_err:
                gpu_info = {"gpu_info_error": str(gpu_err)}
        logger.info(
            "embedding_model_loaded",
            model=settings.embedding_model_name,
            device=device,
            batch_size=effective_embedding_batch_size(device),
            **gpu_info,
        )
    return _model


def model_version() -> str:
    return get_settings().embedding_model_name


def _encode_now(texts: list[str]) -> np.ndarray:
    model = get_embedding_model()
    vecs = model.encode(
        texts,
        batch_size=effective_embedding_batch_size(),
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    return np.asarray(vecs, dtype=np.float32)


class _EncodeBatcher:
    """Single model thread that merges concurrent encode requests.

    A model call costs a fixed 30-80 ms plus a few ms per text, so encoding
    the 3-5 short texts of many concurrent jobs in one call is several times
    faster than one call per job. Callers block on a future from any thread.
    """

    def __init__(self) -> None:
        self._queue: queue.SimpleQueue[tuple[list[str], Future] | None] = queue.SimpleQueue()
        self._thread: threading.Thread | None = None
        self._start_lock = threading.Lock()

    def _ensure_thread(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        with self._start_lock:
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, name="embed-batcher", daemon=True)
                self._thread.start()

    def submit(self, texts: list[str]) -> Future:
        fut: Future = Future()
        if threading.current_thread() is self._thread:
            fut.set_result(_encode_now(texts))
            return fut
        self._ensure_thread()
        self._queue.put((texts, fut))
        return fut

    def _run(self) -> None:
        settings = get_settings()
        window = settings.embedding_batch_window_ms / 1000.0
        cap = settings.embedding_max_batch_texts
        while True:
            first = self._queue.get()
            if first is None:
                return
            batch = [first]
            size = len(first[0])
            deadline = time.monotonic() + window
            while size < cap:
                timeout = deadline - time.monotonic()
                try:
                    item = self._queue.get(timeout=timeout) if timeout > 0 else self._queue.get_nowait()
                except queue.Empty:
                    break
                if item is None:
                    self._queue.put(None)
                    break
                batch.append(item)
                size += len(item[0])
            flat = [t for texts, _ in batch for t in texts]
            try:
                vecs = _encode_now(flat) if flat else np.zeros((0, 0), dtype=np.float32)
            except BaseException as exc:  # deliver to every waiter, keep the thread alive
                for _, fut in batch:
                    if not fut.done():
                        fut.set_exception(exc)
                continue
            offset = 0
            for texts, fut in batch:
                fut.set_result(vecs[offset : offset + len(texts)])
                offset += len(texts)
            if len(batch) > 1:
                logger.debug("embed_batch", requests=len(batch), texts=len(flat))


_batcher = _EncodeBatcher()


def encode_texts(texts: list[str]) -> np.ndarray:
    """Encode texts to L2-normalized float32 vectors (rows). Blocks the caller."""
    clipped = [(t or "")[:_MAX_EMBED_CHARS] for t in texts]
    if not clipped:
        return np.zeros((0, 0), dtype=np.float32)
    return _batcher.submit(clipped).result()


async def encode_texts_async(texts: list[str]) -> np.ndarray:
    """Event-loop friendly ``encode_texts``; merges with concurrent requests."""
    clipped = [(t or "")[:_MAX_EMBED_CHARS] for t in texts]
    if not clipped:
        return np.zeros((0, 0), dtype=np.float32)
    return await asyncio.wrap_future(_batcher.submit(clipped))


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


def matrix_to_bytes(mat: np.ndarray | None) -> bytes | None:
    """Row-stacked chunk vectors as float16; halves storage, cosines move < 0.001."""
    if mat is None or mat.size == 0:
        return None
    return np.asarray(mat, dtype=np.float16).tobytes()


def bytes_to_matrix(raw: bytes | None, dim: int) -> np.ndarray | None:
    if not raw or dim <= 0:
        return None
    flat = np.frombuffer(raw, dtype=np.float16)
    if flat.size % dim:
        return None
    return flat.reshape(-1, dim).astype(np.float32)


# ── Chunking for requirement-level similarity ───────────────────────────────

_MAX_JOB_CHUNKS = 40
_MAX_PROFILE_CHUNKS = 90
_MIN_CHUNK_CHARS = 25
_MAX_CHUNK_CHARS = 400
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?;])\s+(?=[A-Z])")
_BULLET_STRIP = " \t-*\u2022\u25cf\u25aa"
# Legal, benefits and application boilerplate says nothing about the work and
# would only dilute the posting's average similarity.
_BOILERPLATE_RE = re.compile(
    r"equal opportunity|\beeo\b|without regard to|disabilit|veteran|accommodation|benefits|401\(?k|\bpto\b|"
    r"paid time off|health insurance|dental|vision insurance|parental leave|salary range|compensation|base pay|"
    r"pay range|cookie|privacy policy|e-verify|background check|apply now|apply for this|recruiting scam|phishing",
    re.IGNORECASE,
)


def _split_chunks(text: str) -> list[str]:
    out: list[str] = []
    for raw in (text or "").splitlines():
        line = raw.strip(_BULLET_STRIP)
        if not line:
            continue
        parts = _SENTENCE_SPLIT_RE.split(line) if len(line) > 300 else [line]
        for part in parts:
            part = part.strip()
            if len(part) >= _MIN_CHUNK_CHARS:
                out.append(part[:_MAX_CHUNK_CHARS])
    return out


def job_chunks(body: str | None) -> list[str]:
    """Substantive lines of a posting: headings and boilerplate dropped."""
    out: list[str] = []
    for chunk in _split_chunks(body or ""):
        if len(chunk) < 80 and (REQUIRED_HEADING_RE.search(chunk) or PREFERRED_HEADING_RE.search(chunk)):
            continue
        if _BOILERPLATE_RE.search(chunk):
            continue
        out.append(chunk)
        if len(out) >= _MAX_JOB_CHUNKS:
            break
    return out


def profile_chunks(
    *,
    profile_title: str | None,
    profile_summary: str | None,
    work_experience: list | None,
    technical_skills,
) -> list[str]:
    """One chunk per achievement line, so no part of a long profile is cut off."""
    chunks: list[str] = []
    if (profile_title or "").strip():
        chunks.append(str(profile_title).strip())
    chunks.extend(_split_chunks(str(profile_summary or "")))
    for entry in work_experience or []:
        if not isinstance(entry, dict):
            continue
        for key in ("project_intro", "description"):
            chunks.extend(_split_chunks(str(entry.get(key) or "")))
        for item in entry.get("contributions") or []:
            chunks.extend(_split_chunks(str(item)))
    if technical_skills:
        text = technical_skills if isinstance(technical_skills, str) else " ".join(map(str, technical_skills))
        chunks.extend(text[i : i + 300] for i in range(0, min(len(text), 1200), 300))
    seen: set[str] = set()
    unique: list[str] = []
    for chunk in chunks:
        if chunk not in seen:
            seen.add(chunk)
            unique.append(chunk)
    return unique[:_MAX_PROFILE_CHUNKS]


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


_YEARS_RANGE_RE = re.compile(
    r"(\d{1,2})\s*(?:-|to|\u2013|\u2014)\s*\d{1,2}\s*\+?\s*(?:years?|yrs?)", re.IGNORECASE
)


def extract_years_required(text: str | None) -> int | None:
    """Core 'N years of experience' bar of the JD.

    A range counts at its lower end ("8-12 years" asks for 8). Postings often
    list several "N+ years in X" lines for individual tools; the bar for the
    role is the typical one among them, so the median is used, not the largest.
    """
    if not text:
        return None
    values: list[int] = []
    for match in _YEARS_RANGE_RE.finditer(text):
        low = int(match.group(1))
        if 1 <= low <= 20:
            values.append(low)
    for match in _YEARS_RE.finditer(_YEARS_RANGE_RE.sub(" ", text)):
        try:
            years = int(match.group(1))
        except (TypeError, ValueError):
            continue
        if 1 <= years <= 20:
            values.append(years)
    if not values:
        return None
    values.sort()
    return values[len(values) // 2]


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

# Some ATS extractors store only a metadata header ("Posted Date / Employment
# Type / City ...") as the description while the posting itself sits in the
# raw page text. Below this size the description is treated as such a stub.
_STUB_DESCRIPTION_CHARS = 600


def job_body_text(description: str | None, raw_text: str | None) -> str:
    """The text that actually describes the job: description, unless it is a stub."""
    description = description or ""
    raw_text = raw_text or ""
    if len(description.strip()) < _STUB_DESCRIPTION_CHARS and len(raw_text) > len(description):
        return raw_text
    return description or raw_text


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
    description = job_body_text(
        (getattr(extraction, "description", None) if extraction else None), raw_text
    )

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


def job_signals(title: str | None, body: str | None) -> dict:
    """Title-derived role signals and page validity, stored on JobEncoding.signals."""
    return {
        "family": role_family(title),
        "specialty": role_specialty(title),
        "level": role_level(title),
        "posting_issue": non_posting_reason(body),
        "industries": industry_profile(body),
    }


def _analyze_job_text(
    job_id: str,
    title_text: str,
    content_text: str,
    industry_text: str,
    full_text: str,
    job_title: str | None,
    job_company: str | None,
    job_location: str | None,
    job_work_mode: str | None,
    job_source_url: str | None,
    is_remote_flag: bool,
):
    """CPU and model work for ``encode_job``; runs in a worker thread."""
    from app.services.job_field_utils import clean_optional_job_field

    skills = extract_skills_with_importance(full_text)
    years_required = extract_years_required(full_text)
    degree_required = extract_degree_required(full_text)
    clearance, _phrase = requires_security_clearance(full_text)

    chunks = job_chunks(content_text)
    vecs = encode_texts([title_text or content_text[:200], content_text, industry_text] + chunks)
    chunk_mat = vecs[3:] if chunks else None

    # Vector work-mode + MiniLM title/company fill (encoding process only).
    work_mode_to_set: str | None = None
    title_to_set: str | None = None
    company_to_set: str | None = None
    try:
        from app.services.work_mode_classifier import classify_work_mode
        from app.services.metadata_vector_extractor import extract_title_company_ml

        mode, explain = classify_work_mode(
            title=job_title or title_text,
            location=job_location,
            workplace=job_work_mode,
            plain_text=full_text,
            is_remote=is_remote_flag,
            use_vector=True,
        )
        if mode and not (job_work_mode or "").strip():
            work_mode_to_set = mode
            logger.info(
                "work_mode_classified",
                job_id=job_id,
                mode=mode,
                source=explain.get("source"),
                best_cos=explain.get("best_cos"),
            )

        need_title = clean_optional_job_field(job_title) is None
        need_company = clean_optional_job_field(job_company) is None
        if need_title or need_company:
            ml = extract_title_company_ml(
                full_text,
                source_url=job_source_url,
                existing_title=job_title,
                existing_company=job_company,
            )
            if need_title and ml.get("title"):
                title_to_set = ml["title"]
            if need_company and ml.get("company"):
                company_to_set = ml["company"]
            if title_to_set or company_to_set:
                logger.info(
                    "metadata_ml_extracted",
                    job_id=job_id,
                    title=title_to_set,
                    company=company_to_set,
                    explain=ml.get("explain"),
                )
    except Exception as meta_err:
        logger.warning("metadata_ml_classify_failed", job_id=job_id, error=str(meta_err))

    return (
        skills,
        years_required,
        degree_required,
        clearance,
        (vecs[0], vecs[1], vecs[2]),
        chunk_mat,
        work_mode_to_set,
        title_to_set,
        company_to_set,
    )


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
        job_title = job.title
        job_company = job.company
        job_location = job.location
        job_work_mode = job.work_mode
        job_source_url = job.source_url
        job_extraction_id = job.extraction_id
        meta = job.raw_metadata if isinstance(job.raw_metadata, dict) else {}
        is_remote_flag = bool(meta.get("is_remote"))
        posting_body = job_body_text(
            getattr(extraction, "description", None) if extraction else None, raw_text
        )

    if not content_text.strip():
        logger.warning("encode_job_no_text", job_id=job_id)
        return False

    from app.services.job_field_utils import clean_optional_job_field

    (
        skills,
        years_required,
        degree_required,
        clearance,
        (title_vec, content_vec, industry_vec),
        chunk_mat,
        work_mode_to_set,
        title_to_set,
        company_to_set,
    ) = await asyncio.to_thread(
        _analyze_job_text,
        job_id,
        title_text,
        content_text,
        industry_text,
        full_text,
        job_title,
        job_company,
        job_location,
        job_work_mode,
        job_source_url,
        is_remote_flag,
    )
    signals = job_signals(title_to_set or title_text or job_title, posting_body)

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
        row.chunk_vecs = matrix_to_bytes(chunk_mat)
        row.skills = skills
        row.years_required = years_required
        row.degree_required = degree_required
        row.requires_security_clearance = bool(clearance)
        row.signals = signals
        row.encoder_version = ENCODER_VERSION
        row.encoded_at = now

    # One row per transaction: extraction and save workers lock jobs and
    # job_extractions in the other order, so holding both here deadlocks.
    if work_mode_to_set or title_to_set or company_to_set:
        targets = [(Job, job_id)]
        if job_extraction_id:
            targets.append((JobExtraction, job_extraction_id))
        for model, row_id in targets:
            async with get_session() as session:
                target = (
                    await session.execute(select(model).where(model.id == row_id))
                ).scalar_one_or_none()
                if target is None:
                    continue
                if work_mode_to_set and not (target.work_mode or "").strip():
                    target.work_mode = work_mode_to_set
                if title_to_set and not clean_optional_job_field(target.title):
                    target.title = title_to_set[:500]
                if company_to_set and not clean_optional_job_field(target.company):
                    target.company = company_to_set[:500]

    logger.info(
        "job_encoded",
        job_id=job_id,
        skills=len(skills),
        years_required=years_required,
        clearance=clearance,
        chunks=0 if chunk_mat is None else len(chunk_mat),
        family=signals["family"],
        posting_issue=signals["posting_issue"],
        industry_chars=len(industry_text),
        work_mode=work_mode_to_set or job_work_mode,
        title=title_to_set or job_title,
        company=company_to_set or job_company,
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


def build_prefs_text(*, explicit_prefs: str | None, guidance: str | None) -> str:
    """What the candidate actually said they want; empty when they said nothing.

    Nothing is synthesised for an empty profile: padding the text with the
    candidate's own past titles only re-measured title similarity, and a stock
    remote-work sentence made work mode leak into the score.
    """
    parts = [p.strip() for p in (explicit_prefs, guidance) if (p or "").strip()]
    return "\n".join(parts)


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
        guidance = ""
        if (user.resume_tailoring_prompt_mode or "default") == "custom":
            guidance = (user.resume_tailoring_prompt_custom or "").strip()
        prefs_combined = build_prefs_text(
            explicit_prefs=user.job_match_preferences, guidance=guidance
        )
        domain_text = build_domain_proxy_text(work_experience, education)
        profile_title = user.profile_title
        profile_summary = user.profile_summary
        technical_skills = user.technical_skills

        # Vector columns are deferred; the unchanged-profile check below reads them,
        # and a lazy load is impossible under the async session.
        existing = (
            await session.execute(
                select(UserEncoding)
                .options(undefer("*"))
                .where(UserEncoding.user_id == user_id)
            )
        ).scalar_one_or_none()
        new_hash = _profile_hash(
            profile_text, prefs_combined, domain_text, model_version(), ENCODER_VERSION
        )
        if (
            not force
            and existing is not None
            and existing.profile_hash == new_hash
            and existing.encoder_version == ENCODER_VERSION
        ):
            logger.info("encode_user_unchanged", user_id=user_id)
            return True

    if not (profile_text or "").strip():
        logger.info("encode_user_no_profile", user_id=user_id)
        return False

    fields = await build_user_encoding(
        profile_text=profile_text,
        work_experience=work_experience,
        education=education,
        prefs_text=prefs_combined,
        domain_text=domain_text,
        profile_title=profile_title,
        profile_summary=profile_summary,
        technical_skills=technical_skills,
    )

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
        for key, value in fields.items():
            setattr(row, key, value)
        row.profile_hash = new_hash
        row.encoded_at = now

    logger.info(
        "user_encoded",
        user_id=user_id,
        skills=len(fields["skills"]),
        titles=len(fields["title_vecs"]),
        chunks=fields["signals"]["chunks"],
        families=fields["signals"]["families"],
        years_experience=fields["years_experience"],
        prefs_chars=len(prefs_combined),
        domain_chars=len(domain_text),
    )
    return True


async def build_user_encoding(
    *,
    profile_text: str,
    work_experience: list,
    education: list,
    prefs_text: str,
    domain_text: str,
    profile_title: str | None,
    profile_summary: str | None,
    technical_skills,
) -> dict:
    """UserEncoding column values for a profile. Encodes but never touches the DB."""
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

    chunks = profile_chunks(
        profile_title=profile_title,
        profile_summary=profile_summary,
        work_experience=work_experience,
        technical_skills=technical_skills,
    ) or _split_chunks(profile_text)[:_MAX_PROFILE_CHUNKS]

    to_encode = [profile_text] + titles + [domain_text] + ([prefs_text] if prefs_text else []) + chunks
    vecs = await encode_texts_async(to_encode)
    experience_vec = vecs[0]
    title_vecs = [
        {"title": titles[i], "vec": vec_to_b64(vecs[1 + i])} for i in range(len(titles))
    ]
    domain_vec = vecs[1 + len(titles)]
    offset = 2 + len(titles)
    prefs_vec = None
    if prefs_text:
        prefs_vec = vecs[offset]
        offset += 1
    chunk_mat = vecs[offset:] if chunks else None

    family_titles = ([str(profile_title)] if (profile_title or "").strip() else []) + titles[:3]
    recent_text = " ".join(
        str(entry.get(key) or "")
        for entry in work_experience[:2]
        if isinstance(entry, dict)
        for key in ("job_title", "project_intro", "description")
    )
    # Only titles that state a seniority count; the rest fall back to years.
    title_levels = [
        lvl
        for lvl in (role_level(t, default=None) for t in family_titles[:2])
        if lvl is not None
    ]
    signals = {
        "families": [role_family(t) for t in family_titles],
        "specialties": user_specialties(family_titles, skills, skill_category, recent_text),
        "level": max(title_levels) if title_levels else None,
        "level_from_years": level_from_years(years_experience),
        "industries": industry_profile(
            " ".join([profile_summary or ""] + [_entry_text(e) for e in work_experience if isinstance(e, dict)])
        ),
        "preferred_industries": industry_profile(prefs_text, min_hits=1),
        "chunks": 0 if chunk_mat is None else len(chunk_mat),
    }

    return {
        "model_version": model_version(),
        "experience_vec": vec_to_bytes(experience_vec),
        "prefs_vec": vec_to_bytes(prefs_vec),
        "domain_vec": vec_to_bytes(domain_vec),
        "chunk_vecs": matrix_to_bytes(chunk_mat),
        "title_vecs": title_vecs,
        "skills": skills,
        "years_experience": years_experience,
        "has_degree": has_degree,
        "signals": signals,
        "encoder_version": ENCODER_VERSION,
    }
