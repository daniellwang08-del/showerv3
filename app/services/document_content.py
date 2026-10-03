"""Build the exact design a tailored document is rendered from."""

from __future__ import annotations

from typing import Any

from app.models.resume_design_schemas import ResumeContent, ResumeDesign


def _s(v: Any) -> str:
    return "" if v is None else str(v)


def content_from_profile(profile: dict[str, Any]) -> ResumeContent:
    """Seed a content override from the profile payload (mirrors `profileToContent`)."""
    return ResumeContent.model_validate(
        {
            "name_first": _s(profile.get("name_first")),
            "name_middle": _s(profile.get("name_middle")),
            "name_last": _s(profile.get("name_last")),
            "title": _s(profile.get("title")),
            "email": _s(profile.get("email")),
            "phone_country_code": _s(profile.get("phone_country_code")),
            "phone_number": _s(profile.get("phone_number")),
            "linkedin_url": _s(profile.get("linkedin_url")),
            "github_url": _s(profile.get("github_url")),
            "profile_summary": _s(profile.get("profile_summary")),
            "technical_skills": [
                {"category": _s(s.get("category")), "skills": _s(s.get("skills"))}
                for s in profile.get("technical_skills") or []
                if isinstance(s, dict)
            ],
            "work_experience": [
                {
                    "company_name": _s(w.get("company_name")),
                    "job_title": _s(w.get("job_title")),
                    "period_start": _s(w.get("period_start")),
                    "period_end": _s(w.get("period_end")),
                    "location": _s(w.get("location")),
                    "job_type": _s(w.get("job_type")),
                    "employment_type": _s(w.get("employment_type")),
                    "project_title": _s(w.get("project_title")),
                    "project_intro": _s(w.get("project_intro")),
                    "contributions": [_s(c) for c in w.get("contributions") or []],
                    "used_skills": _s(w.get("used_skills")),
                    "description": _s(w.get("description")),
                }
                for w in profile.get("work_experience") or []
                if isinstance(w, dict)
            ],
            "education": [
                {
                    "university_name": _s(e.get("university_name")),
                    "degree": _s(e.get("degree")),
                    "mark": _s(e.get("mark")),
                    "period_start": _s(e.get("period_start")),
                    "period_end": _s(e.get("period_end")),
                    "location": _s(e.get("location")),
                    "description": _s(e.get("description")),
                }
                for e in profile.get("education") or []
                if isinstance(e, dict)
            ],
            "certificates": [
                {"name": _s(c.get("name")), "issued_at": _s(c.get("issued_at")), "url": _s(c.get("url"))}
                for c in profile.get("certificates") or []
                if isinstance(c, dict)
            ],
        }
    )


def with_profile_content(design: ResumeDesign, profile: dict[str, Any]) -> ResumeDesign:
    """Ensure the design carries a full content override (profile data when it has none)."""
    if design.content is not None:
        return design
    return design.model_copy(update={"content": content_from_profile(profile)})


def tailored_design(design: ResumeDesign, profile: dict[str, Any], tailored: dict[str, Any]) -> ResumeDesign:
    """The design a job's tailored resume renders from: theme + profile content with the
    tailored summary, skills and experience applied on top. Per-job builds ignore any
    manual content override on the design (see `ResumeContent`)."""
    from app.services.resume_design_service import _merge_tailored_into_design

    base = design.model_copy(update={"content": content_from_profile(profile)})
    return _merge_tailored_into_design(base, tailored)
