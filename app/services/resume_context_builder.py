"""Build render context dict from user profile, tailored JSON, and job metadata."""

from __future__ import annotations

import re
from typing import Any

from app.models.database import Job, User
from app.services.job_field_utils import parse_job_title
from app.utils.flexible_date import format_flexible_date, format_flexible_period


# Markdown stripping: LLM-tailored text (bullets, summaries, project descriptions)
# often arrives with **bold**/`code`/[link](url) markup. The resume document and
# its DOCX/PDF export render text VERBATIM, so this markup would show literally
# (e.g. "**Java**") and, worse, gets re-parsed back into Workday's plain-text
# Role Description by its resume parser. Strip it to clean, typable plain text.
_MD_IMG_RE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_MD_BOLD_RE = re.compile(r"\*\*(.+?)\*\*|__(.+?)__", re.DOTALL)
_MD_CODE_RE = re.compile(r"`([^`]+)`")
_MD_HEAD_RE = re.compile(r"(?m)^\s{0,3}#{1,6}\s*")
_MD_QUOTE_RE = re.compile(r"(?m)^\s{0,3}>\s?")
_MD_BULLET_RE = re.compile(r"(?m)^(\s*)[*+]\s+")


def _plain_text(text: Any) -> str:
    s = str(text or "")
    if not s:
        return ""
    s = _MD_IMG_RE.sub(r"\1", s)
    s = _MD_LINK_RE.sub(r"\1", s)
    s = _MD_BOLD_RE.sub(lambda m: m.group(1) or m.group(2) or "", s)
    s = _MD_CODE_RE.sub(r"\1", s)
    s = _MD_HEAD_RE.sub("", s)
    s = _MD_QUOTE_RE.sub("", s)
    s = _MD_BULLET_RE.sub(r"\1- ", s)
    s = s.replace("**", "")  # any stray/unbalanced bold markers
    s = "\n".join(line.rstrip() for line in s.split("\n"))
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def _render_text(text: Any) -> str:
    """Like :func:`_plain_text` but *preserves* the resume's inline formatting markers
    (``**bold**`` / ``*italic*`` / ``__underline__``).

    The DOCX fill engine and the live preview both turn these markers into real
    bold/italic/underline runs, so the tailoring LLM's ATS-keyword ``**highlights**`` and
    any manual emphasis survive into the rendered document. Other markdown (links, images,
    code, headings, quotes) is still flattened so it never shows literally."""
    s = str(text or "")
    if not s:
        return ""
    s = _MD_IMG_RE.sub(r"\1", s)
    s = _MD_LINK_RE.sub(r"\1", s)
    s = _MD_CODE_RE.sub(r"\1", s)
    s = _MD_HEAD_RE.sub("", s)
    s = _MD_QUOTE_RE.sub("", s)
    # Safe against "*italic*": _MD_BULLET_RE requires whitespace after the marker, so a
    # leading "* " bullet normalises to "- " while "*italic*" (no space) is left intact.
    s = _MD_BULLET_RE.sub(r"\1- ", s)
    s = "\n".join(line.rstrip() for line in s.split("\n"))
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def _format_period(start: str | None, end: str | None) -> str:
    return format_flexible_period(start, end)


def _format_phone(user: User) -> str:
    cc = (getattr(user, "phone_country_code", None) or "").strip()
    num = (getattr(user, "phone_number", None) or "").strip()
    if cc and num:
        return f"{cc} {num}".strip()
    return num or cc


def _full_name(user: User) -> str:
    parts = [
        (getattr(user, "name_first", None) or "").strip(),
        (getattr(user, "name_middle", None) or "").strip(),
        (getattr(user, "name_last", None) or "").strip(),
    ]
    return " ".join(p for p in parts if p).strip()


def _profile_work_rows(user: User) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in getattr(user, "work_experience", None) or []:
        if not isinstance(item, dict):
            continue
        company = (item.get("company_name") or "").strip()
        title = (item.get("job_title") or "").strip()
        if not company and not title:
            continue
        contributions = [
            str(c).strip()
            for c in (item.get("contributions") or [])
            if isinstance(c, (str, int, float)) and str(c).strip()
        ]
        rows.append(
            {
                "company_name": company,
                "job_title": title,
                "period": _format_period(item.get("period_start"), item.get("period_end")),
                "location": (item.get("location") or "").strip(),
                "job_type": (item.get("job_type") or "").strip(),
                "employment_type": (item.get("employment_type") or "").strip(),
                "project_title": (item.get("project_title") or "").strip(),
                "project_intro": (item.get("project_intro") or "").strip(),
                "contributions": contributions,
                "used_skills": (item.get("used_skills") or "").strip(),
                "description": (item.get("description") or "").strip(),
            }
        )
    return rows


def _norm_company(value: object) -> str:
    return str(value or "").strip().lower()


def _match_tailored_work_row(
    tailored_rows: list[dict],
    *,
    company: str,
    title: str,
    used: set[int],
) -> dict:
    """Prefer company+title, then company-only, then first unused row (order fallback)."""
    company_l = _norm_company(company)
    title_l = str(title or "").strip().lower()
    if company_l:
        for i, row in enumerate(tailored_rows):
            if i in used or not isinstance(row, dict):
                continue
            if _norm_company(row.get("company_name")) != company_l:
                continue
            if title_l and str(row.get("job_title") or "").strip().lower() == title_l:
                used.add(i)
                return row
        for i, row in enumerate(tailored_rows):
            if i in used or not isinstance(row, dict):
                continue
            if _norm_company(row.get("company_name")) == company_l:
                used.add(i)
                return row
    for i, row in enumerate(tailored_rows):
        if i in used or not isinstance(row, dict):
            continue
        used.add(i)
        return row
    return {}


def _merge_tailored_work_experience(profile_rows: list[dict], tailored_rows: list[dict]) -> list[dict[str, Any]]:
    """Merge profile factual fields with tailored narrative, matching by company (not index)."""
    safe_tailored = [r for r in (tailored_rows or []) if isinstance(r, dict)]
    used: set[int] = set()
    merged: list[dict[str, Any]] = []
    for profile_row in profile_rows:
        tailored = _match_tailored_work_row(
            safe_tailored,
            company=str(profile_row.get("company_name") or ""),
            title=str(profile_row.get("job_title") or ""),
            used=used,
        )
        bullets = []
        for b in tailored.get("bullets") or []:
            if isinstance(b, str) and b.strip():
                cleaned = _render_text(b)
                if cleaned:
                    bullets.append(cleaned)
        # Structured profile contributions are the fallback when the LLM omits bullets.
        if not bullets:
            for b in profile_row.get("contributions") or []:
                cleaned = _render_text(b)
                if cleaned:
                    bullets.append(cleaned)
        merged.append(
            {
                "company_name": (tailored.get("company_name") or profile_row.get("company_name") or "").strip(),
                "job_title": (tailored.get("job_title") or profile_row.get("job_title") or "").strip(),
                "period": profile_row.get("period") or "",
                "location": profile_row.get("location") or "",
                "employment_type": profile_row.get("employment_type") or "",
                "job_type": profile_row.get("job_type") or "",
                "project_name": (tailored.get("project_name") or profile_row.get("project_title") or None),
                "project_description": _render_text(
                    tailored.get("project_description")
                    or profile_row.get("project_intro")
                    or profile_row.get("description")
                    or ""
                ),
                "bullets": bullets,
                "used_skills": _render_text(tailored.get("used_skills") or profile_row.get("used_skills") or ""),
            }
        )
    return merged


def _saved_skills_style(user: User) -> dict[str, Any] | None:
    raw = getattr(user, "resume_template_design", None)
    if isinstance(raw, dict):
        sections = raw.get("sections")
        if isinstance(sections, dict) and isinstance(sections.get("skills_style"), dict):
            return sections["skills_style"]
    return None


def _saved_design_colors(user: User) -> dict[str, Any] | None:
    raw = getattr(user, "resume_template_design", None)
    if isinstance(raw, dict) and isinstance(raw.get("colors"), dict):
        return raw["colors"]
    return None


def _saved_experience_style(user: User) -> dict[str, Any] | None:
    raw = getattr(user, "resume_template_design", None)
    if isinstance(raw, dict):
        sections = raw.get("sections")
        if isinstance(sections, dict) and isinstance(sections.get("experience_style"), dict):
            return sections["experience_style"]
    return None


def _saved_layout_metrics(user: User) -> dict[str, Any] | None:
    """Browser-measured per-role body gaps (pt) from the user's saved design, so the
    fill engine reproduces the exact spacing the preview drew."""
    raw = getattr(user, "resume_template_design", None)
    if isinstance(raw, dict):
        layout = raw.get("layout")
        if isinstance(layout, dict) and isinstance(layout.get("layout_metrics"), dict):
            return layout["layout_metrics"]
    return None


def _saved_section_options(user: User) -> dict[str, Any] | None:
    raw = getattr(user, "resume_template_design", None)
    if isinstance(raw, dict) and isinstance(raw.get("sections"), dict):
        return raw["sections"]
    return None


def build_render_context(
    user: User,
    tailored: dict[str, Any],
    job: Job | None = None,
) -> dict[str, Any]:
    profile_rows = _profile_work_rows(user)
    tailored_rows = tailored.get("work_experience") if isinstance(tailored.get("work_experience"), list) else []
    work_experience = _merge_tailored_work_experience(profile_rows, tailored_rows)

    skills: list[dict[str, str]] = []
    for item in tailored.get("technical_skills") or []:
        if not isinstance(item, dict):
            continue
        cat = _plain_text(item.get("category"))
        vals = _render_text(item.get("skills"))
        if cat and vals:
            skills.append({"category": cat, "skills": vals})

    education: list[dict[str, str]] = []
    for item in getattr(user, "education", None) or []:
        if not isinstance(item, dict):
            continue
        uni = (item.get("university_name") or "").strip()
        degree = (item.get("degree") or "").strip()
        if uni or degree:
            education.append(
                {
                    "university_name": uni,
                    "degree": degree,
                    "period": _format_period(item.get("period_start"), item.get("period_end")),
                    "mark": (item.get("mark") or "").strip(),
                }
            )

    certificates: list[dict[str, str]] = []
    for item in getattr(user, "certificates", None) or []:
        if isinstance(item, dict):
            name = (item.get("name") or "").strip()
            if name:
                row = {"name": name}
                issued = format_flexible_date((item.get("issued_at") or "").strip())
                url = (item.get("url") or "").strip()
                if issued:
                    row["issued_at"] = issued
                if url:
                    row["url"] = url
                certificates.append(row)

    return {
        "profile": {
            "full_name": _full_name(user),
            "title": (getattr(user, "profile_title", None) or "").strip(),
            "email": (getattr(user, "profile_email", None) or getattr(user, "email", None) or "").strip(),
            "phone": _format_phone(user),
            "linkedin": (getattr(user, "linkedin_url", None) or "").strip(),
            "github": (getattr(user, "github_url", None) or "").strip(),
            "summary": (getattr(user, "profile_summary", None) or "").strip(),
            "work_experience": profile_rows,
            "education": education,
            "certificates": certificates,
        },
        "tailored": {
            "profile_summary": _render_text(tailored.get("profile_summary")),
            "technical_skills": skills,
            "work_experience": work_experience,
            # Skills theme + palette so the fill engine can style skills like the
            # live preview. Sourced from the user's saved design; the builder preview
            # overrides these with the design being previewed.
            "skills_style": tailored.get("skills_style") or _saved_skills_style(user),
            # Experience theme so the fill engine can style work-experience entries
            # like the live preview. Builder preview overrides this with the design
            # being previewed.
            "experience_style": tailored.get("experience_style") or _saved_experience_style(user),
            "section_options": tailored.get("section_options") or _saved_section_options(user),
            "colors": tailored.get("colors") or _saved_design_colors(user),
            # Browser-measured per-role body gaps (pt); the builder preview overrides this
            # with the design being previewed, so the .docx spacing matches the preview.
            "layout_metrics": tailored.get("layout_metrics") or _saved_layout_metrics(user),
        },
        "job": {
            "company": (job.company if job else None) or "Unknown",
            "title": parse_job_title(job.title if job else None),
            "location": (job.location if job else None) or "",
        },
    }


def resolve_context_path(context: dict[str, Any], path: str) -> Any:
    if not path:
        return None
    cur: Any = context
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def build_preview_tailored(user: User) -> dict[str, Any]:
    """Sample tailored payload for template preview (no job-specific AI output)."""
    profile_rows = _profile_work_rows(user)
    skills: list[dict[str, str]] = []
    for item in getattr(user, "technical_skills", None) or []:
        if not isinstance(item, dict):
            continue
        cat = str(item.get("category") or "").strip()
        vals = str(item.get("skills") or "").strip()
        if cat and vals:
            skills.append({"category": cat, "skills": vals})
    if not skills:
        skills = [{"category": "Core skills", "skills": "Leadership, communication, problem solving"}]

    work: list[dict[str, Any]] = []
    for row in profile_rows:
        intro = (row.get("project_intro") or row.get("description") or "").strip()
        if not intro:
            intro = f"Sample accomplishments at {row.get('company_name') or 'the organization'}."
        # Mirror the live preview: bullets come from structured contributions when
        # present, otherwise the fill engine parses them out of the description/intro.
        # Do NOT inject a placeholder bullet here - the React preview never adds one,
        # so injecting it makes the rendered DOCX one bullet taller per job than the
        # preview and silently overflows onto an extra page.
        contributions = row.get("contributions") or []
        work.append(
            {
                "company_name": row.get("company_name") or "",
                "job_title": row.get("job_title") or "",
                "employment_type": row.get("employment_type") or "",
                "job_type": row.get("job_type") or "",
                "project_name": row.get("project_title") or "",
                "project_description": intro,
                "bullets": contributions,
                "used_skills": row.get("used_skills") or "",
            }
        )

    summary = (getattr(user, "profile_summary", None) or "").strip()
    if not summary:
        summary = "Experienced professional with a track record of delivering results."

    return {
        "profile_summary": summary,
        "technical_skills": skills,
        "work_experience": work,
    }
