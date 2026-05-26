"""
Upload, text extraction, and structured parsing of per-company project source documents (Option C).
"""

from __future__ import annotations

import json
import re
from typing import Any

from openai import AsyncOpenAI

from app.core.config import get_settings
from app.core.exceptions import AIParsingError
from app.core.logging import get_logger
from app.core.openai_client import get_openai_client_for_user
from app.models.database import ProfileSourceDocument
from app.models.profile_source_schemas import (
    ProfileSourceDocumentResponse,
    ProfileSourceDocumentUploadResponse,
    SourceDocumentProject,
    SourceDocumentStructured,
)
from app.services.resume_parse_service import (
    detect_resume_kind,
    docx_to_plain_text,
    pdf_to_plain_text_any,
)
from app.storage.database import get_session
from app.storage.profile_source_document_repository import ProfileSourceDocumentRepository
from app.utils.company_name_utils import company_names_match

try:
    from langfuse import observe
except ImportError:
    from functools import wraps

    def observe(**_kw):
        def _decorator(fn):
            @wraps(fn)
            async def _wrapper(*a, **k):
                return await fn(*a, **k)

            return _wrapper

        return _decorator

logger = get_logger(__name__)

MAX_SOURCE_BYTES = 10 * 1024 * 1024
MAX_SOURCE_TEXT_CHARS = 200_000
MAX_PARSE_TEXT_CHARS = 100_000
MAX_PDF_PAGES = 50

SOURCE_PARSE_INSTRUCTIONS = """You extract structured project information from a candidate's detailed work/project document.

Return ONLY valid JSON:
{
  "company_name": "<employer or company this document describes, or null>",
  "projects": [
    {
      "name": "<project or initiative name>",
      "summary": "<1-3 sentence overview>",
      "technologies": ["<tech>", ...],
      "responsibilities": ["<what the candidate did>", ...],
      "metrics": ["<quantified result>", ...],
      "outcomes": ["<business/technical outcome>", ...]
    }
  ]
}

Rules:
- Preserve factual wording from the source; do not invent metrics or technologies.
- Split distinct projects into separate objects.
- Include all substantive projects described in the document.
- If company name appears in the document header or repeatedly, set company_name.
- Use [] for empty lists; use null only for unknown company_name.
"""


def _truncate(text: str, max_len: int, suffix: str = "...") -> str:
    if not text or len(text) <= max_len:
        return text or ""
    return text[: max_len - len(suffix)].rstrip() + suffix


def _parse_json_object(content: str) -> dict[str, Any]:
    raw = content.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("Expected JSON object")
    return data


def extract_document_text(*, raw: bytes, filename: str) -> tuple[str, str, list[str]]:
    """Return (plain_text, source_kind, warnings)."""
    if len(raw) > MAX_SOURCE_BYTES:
        raise ValueError(f"File too large (max {MAX_SOURCE_BYTES // (1024 * 1024)} MB).")

    kind = detect_resume_kind(raw, filename)
    warnings: list[str] = []

    if kind == "pdf":
        text = pdf_to_plain_text_any(raw, max_pages=MAX_PDF_PAGES)
        if not text.strip():
            raise ValueError(
                "Could not extract text from PDF. Ensure the file is text-based or install PyMuPDF."
            )
    elif kind == "docx":
        text = docx_to_plain_text(raw)
        if not text.strip():
            raise ValueError("No text found in DOCX.")
    else:
        raise ValueError("Unsupported file type. Upload PDF or DOCX.")

    if len(text) > MAX_SOURCE_TEXT_CHARS:
        text = text[:MAX_SOURCE_TEXT_CHARS]
        warnings.append(
            f"Document truncated to {MAX_SOURCE_TEXT_CHARS:,} characters for storage."
        )

    return text, kind, warnings


def _resolve_company_name(
    structured: SourceDocumentStructured,
    hint: str | None,
    profile_companies: list[str],
) -> str | None:
    candidates = [
        (hint or "").strip(),
        (structured.company_name or "").strip(),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        for profile_co in profile_companies:
            if company_names_match(candidate, profile_co):
                return profile_co
        return candidate[:200]
    return None


def _normalize_structured(data: dict[str, Any]) -> SourceDocumentStructured:
    projects_raw = data.get("projects") if isinstance(data.get("projects"), list) else []
    projects = []
    for item in projects_raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip() or None

        def _str_list(key: str) -> list[str]:
            val = item.get(key)
            if not isinstance(val, list):
                return []
            return [str(x).strip() for x in val if str(x).strip()]

        summary = str(item.get("summary") or "").strip() or None
        if not name and not summary and not _str_list("responsibilities"):
            continue
        projects.append(
            SourceDocumentProject(
                name=name,
                summary=summary,
                technologies=_str_list("technologies"),
                responsibilities=_str_list("responsibilities"),
                metrics=_str_list("metrics"),
                outcomes=_str_list("outcomes"),
            )
        )
    company = str(data.get("company_name") or "").strip() or None
    return SourceDocumentStructured(company_name=company, projects=projects)


@observe(name="parse_source_document_structured")
async def parse_source_document_structured(
    *,
    text: str,
    profile_companies: list[str],
    user_id: str | None = None,
) -> SourceDocumentStructured:
    client: AsyncOpenAI = await get_openai_client_for_user(user_id)
    settings = get_settings()
    clipped = _truncate(text, MAX_PARSE_TEXT_CHARS)
    profile_hint = ""
    if profile_companies:
        profile_hint = (
            "\n\nProfile work history companies (prefer matching one of these for company_name): "
            + ", ".join(profile_companies)
        )

    user_msg = (
        "Extract structured project data from the document below.\n"
        f"{profile_hint}\n\n---\n{clipped}\n---\n"
        "Return JSON only."
    )

    resp = await client.chat.completions.create(
        model=settings.openai_model,
        messages=[
            {"role": "system", "content": SOURCE_PARSE_INSTRUCTIONS},
            {"role": "user", "content": user_msg},
        ],
        temperature=0.0,
        max_tokens=min(max(settings.openai_max_tokens, 8192), 16384),
        response_format={"type": "json_object"},
    )
    raw = resp.choices[0].message.content
    if not raw:
        raise AIParsingError("Empty model response during source document parse")
    try:
        data = _parse_json_object(raw)
        return _normalize_structured(data)
    except (json.JSONDecodeError, ValueError) as e:
        raise AIParsingError(f"Invalid structured parse response: {e}") from e


def document_to_response(doc: ProfileSourceDocument) -> ProfileSourceDocumentResponse:
    return ProfileSourceDocumentResponse(
        id=doc.id,
        filename=doc.filename,
        source_kind=doc.source_kind,
        company_name=doc.company_name,
        char_count=int(doc.char_count or 0),
        project_count=int(doc.project_count or 0),
        parse_status=doc.parse_status,
        parse_error=doc.parse_error,
        created_at=doc.created_at,
        updated_at=doc.updated_at,
    )


def profile_companies_from_user(user) -> list[str]:
    names: list[str] = []
    for item in getattr(user, "work_experience", None) or []:
        if isinstance(item, dict):
            co = (item.get("company_name") or "").strip()
            if co:
                names.append(co)
    return names


@observe(name="upload_profile_source_document")
async def upload_and_parse_source_document(
    *,
    user_id: str,
    raw: bytes,
    filename: str,
    company_name_hint: str | None = None,
) -> ProfileSourceDocumentUploadResponse:
    from app.storage.user_repository import UserRepository

    text, source_kind, warnings = extract_document_text(raw=raw, filename=filename)

    async with get_session() as session:
        user_repo = UserRepository(session)
        doc_repo = ProfileSourceDocumentRepository(session)
        user = await user_repo.get_by_id(user_id)
        profile_companies = profile_companies_from_user(user) if user else []

        row = await doc_repo.create(
            user_id=user_id,
            filename=(filename or "document")[:500],
            source_kind=source_kind,
            company_name=(company_name_hint or "").strip()[:200] or None,
            extracted_text=text,
            char_count=len(text),
            parse_status="parsing",
        )

        try:
            structured = await parse_source_document_structured(
                text=text,
                profile_companies=profile_companies,
                user_id=user_id,
            )
            resolved_company = _resolve_company_name(
                structured,
                company_name_hint,
                profile_companies,
            )
            row.structured_data = structured.model_dump()
            row.company_name = resolved_company
            row.project_count = len(structured.projects)
            row.parse_status = "completed"
            row.parse_error = None
        except Exception as e:
            logger.warning("source_document_parse_failed", user_id=user_id, error=str(e))
            row.parse_status = "failed"
            row.parse_error = str(e)[:2000]
            row.project_count = 0
            warnings.append("Structured parse failed; document text was saved.")

        await session.commit()
        await session.refresh(row)
        return ProfileSourceDocumentUploadResponse(
            document=document_to_response(row),
            warnings=warnings,
        )


async def update_source_document_company(
    *,
    user_id: str,
    doc_id: str,
    company_name: str,
) -> ProfileSourceDocumentResponse | None:
    async with get_session() as session:
        repo = ProfileSourceDocumentRepository(session)
        doc = await repo.get_by_id(doc_id, user_id)
        if not doc:
            return None
        doc.company_name = company_name.strip()[:200]
        await session.commit()
        await session.refresh(doc)
        return document_to_response(doc)


async def delete_source_document(*, user_id: str, doc_id: str) -> bool:
    async with get_session() as session:
        repo = ProfileSourceDocumentRepository(session)
        doc = await repo.get_by_id(doc_id, user_id)
        if not doc:
            return False
        await repo.delete(doc)
        await session.commit()
        return True


async def list_source_documents(user_id: str) -> list[ProfileSourceDocumentResponse]:
    async with get_session() as session:
        repo = ProfileSourceDocumentRepository(session)
        rows = await repo.list_for_user(user_id)
        return [document_to_response(r) for r in rows]


async def reparse_source_document(*, user_id: str, doc_id: str) -> ProfileSourceDocumentResponse | None:
    from app.storage.user_repository import UserRepository

    async with get_session() as session:
        user_repo = UserRepository(session)
        doc_repo = ProfileSourceDocumentRepository(session)
        doc = await doc_repo.get_by_id(doc_id, user_id)
        if not doc:
            return None
        user = await user_repo.get_by_id(user_id)
        profile_companies = profile_companies_from_user(user) if user else []
        text = (doc.extracted_text or "").strip()
        if not text:
            doc.parse_status = "failed"
            doc.parse_error = "No extracted text to parse"
            await session.commit()
            return document_to_response(doc)

        doc.parse_status = "parsing"
        doc.parse_error = None
        await session.flush()

        try:
            structured = await parse_source_document_structured(
                text=text,
                profile_companies=profile_companies,
                user_id=user_id,
            )
            doc.structured_data = structured.model_dump()
            if not doc.company_name:
                doc.company_name = _resolve_company_name(structured, None, profile_companies)
            doc.project_count = len(structured.projects)
            doc.parse_status = "completed"
        except Exception as e:
            doc.parse_status = "failed"
            doc.parse_error = str(e)[:2000]

        await session.commit()
        await session.refresh(doc)
        return document_to_response(doc)
