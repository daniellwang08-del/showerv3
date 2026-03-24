"""
Convert user profile data to OpenAI-optimized text format.
Produces a resume-style document for use as context in Chat Completions.
"""

from typing import Any


def _s(obj: Any, key: str, default: str = "") -> str:
    """Safe string getter for dict or object."""
    if obj is None:
        return default
    val = obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)
    if val is None:
        return default
    return str(val).strip() if isinstance(val, str) else str(val)


def _list(obj: Any, key: str) -> list:
    """Safe list getter for dict or object."""
    if obj is None:
        return []
    val = obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)
    if val is None:
        return []
    return list(val) if isinstance(val, (list, tuple)) else []


def _format_period(start: str, end: str) -> str:
    if start and end:
        return f"{start} – {end}"
    if start:
        return f"{start} – Present"
    if end:
        return end
    return ""


def user_profile_to_openai_text(profile: Any) -> str:
    """
    Convert user profile to OpenAI-optimized resume-style text.

    Args:
        profile: User model instance, dict, or object with profile fields.
                 Supports: name_first, name_middle, name_last, profile_title, profile_email,
                 phone_country_code, phone_number, linkedin_url, github_url, profile_summary,
                 technical_skills, work_experience, education, certificates, extra.

    Returns:
        Formatted text suitable for OpenAI Chat Completions context.
    """
    parts: list[str] = []

    # Header: name and contact
    name_parts = [
        _s(profile, "name_first"),
        _s(profile, "name_middle"),
        _s(profile, "name_last"),
    ]
    full_name = " ".join(p for p in name_parts if p).strip()
    if not full_name:
        full_name = _s(profile, "name")

    contact_parts: list[str] = []
    title = _s(profile, "profile_title") or _s(profile, "title")
    if title:
        contact_parts.append(title)
    email = _s(profile, "profile_email") or _s(profile, "email")
    if email:
        contact_parts.append(email)
    phone_cc = _s(profile, "phone_country_code")
    phone_num = _s(profile, "phone_number")
    if phone_cc and phone_num:
        contact_parts.append(f"{phone_cc} {phone_num}".strip())
    elif phone_num:
        contact_parts.append(phone_num)
    links: list[str] = []
    if _s(profile, "linkedin_url"):
        links.append(f"LinkedIn: {_s(profile, 'linkedin_url')}")
    if _s(profile, "github_url"):
        links.append(f"GitHub: {_s(profile, 'github_url')}")
    if links:
        contact_parts.append(" | ".join(links))

    if full_name:
        parts.append(f"# {full_name}")
    if contact_parts:
        parts.append(" | ".join(contact_parts))
    if parts:
        parts.append("")  # blank line

    # Profile summary
    summary = _s(profile, "profile_summary")
    if summary:
        parts.append("## Summary")
        parts.append(summary)
        parts.append("")

    # Technical skills
    tech_skills = _list(profile, "technical_skills")
    if tech_skills:
        parts.append("## Technical Skills")
        for block in tech_skills:
            cat = (block.get("category") if isinstance(block, dict) else getattr(block, "category", "")) or ""
            skills = (block.get("skills") if isinstance(block, dict) else getattr(block, "skills", "")) or ""
            if cat or skills:
                line = f"- **{cat}**: {skills}" if cat else f"- {skills}"
                parts.append(line)
        parts.append("")

    # Work experience
    work_exp = _list(profile, "work_experience")
    if work_exp:
        parts.append("## Work Experience")
        for w in work_exp:
            company = (w.get("company_name") if isinstance(w, dict) else getattr(w, "company_name", "")) or ""
            job_title = (w.get("job_title") if isinstance(w, dict) else getattr(w, "job_title", "")) or ""
            period = _format_period(
                (w.get("period_start") if isinstance(w, dict) else getattr(w, "period_start", None)) or "",
                (w.get("period_end") if isinstance(w, dict) else getattr(w, "period_end", None)) or "",
            )
            location = (w.get("location") if isinstance(w, dict) else getattr(w, "location", None)) or ""
            job_type = (w.get("job_type") if isinstance(w, dict) else getattr(w, "job_type", None)) or ""
            desc = (w.get("description") if isinstance(w, dict) else getattr(w, "description", None)) or ""

            sub_parts: list[str] = []
            header = f"**{company}**"
            if job_title:
                header += f" | {job_title}"
            if period:
                header += f" | {period}"
            sub_parts.append(header)
            meta = [m for m in [location, job_type] if m]
            if meta:
                sub_parts.append(", ".join(meta))
            if desc:
                sub_parts.append(desc)
            parts.append("\n".join(sub_parts))
            parts.append("")
        parts.append("")

    # Education
    education = _list(profile, "education")
    if education:
        parts.append("## Education")
        for e in education:
            univ = (e.get("university_name") if isinstance(e, dict) else getattr(e, "university_name", "")) or ""
            degree = (e.get("degree") if isinstance(e, dict) else getattr(e, "degree", "")) or ""
            mark = (e.get("mark") if isinstance(e, dict) else getattr(e, "mark", None)) or ""
            period = _format_period(
                (e.get("period_start") if isinstance(e, dict) else getattr(e, "period_start", None)) or "",
                (e.get("period_end") if isinstance(e, dict) else getattr(e, "period_end", None)) or "",
            )
            location = (e.get("location") if isinstance(e, dict) else getattr(e, "location", None)) or ""
            desc = (e.get("description") if isinstance(e, dict) else getattr(e, "description", None)) or ""

            sub_parts = [f"**{univ}** | {degree}"]
            if mark:
                sub_parts[0] += f" | {mark}"
            if period:
                sub_parts.append(period)
            if location:
                sub_parts.append(location)
            if desc:
                sub_parts.append(desc)
            parts.append("\n".join(sub_parts))
            parts.append("")
        parts.append("")

    # Certificates
    certs = _list(profile, "certificates")
    if certs:
        parts.append("## Certificates")
        for c in certs:
            name = (c.get("name") if isinstance(c, dict) else getattr(c, "name", "")) or ""
            if name:
                parts.append(f"- {name}")
        parts.append("")

    # Extra
    extra = _list(profile, "extra")
    if extra:
        parts.append("## Additional Information")
        for line in extra:
            if isinstance(line, str) and line.strip():
                parts.append(f"- {line.strip()}")
        parts.append("")

    return "\n".join(parts).strip()
