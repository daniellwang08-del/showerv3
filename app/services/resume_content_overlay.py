"""Overlay a design's manual content override onto a User for rendering.

Both the compiler (`compile_design`) and the context builder (`build_render_context` /
`build_preview_tailored`) read résumé content off the ``User`` via a fixed set of
attribute names. When the builder's Content panel has authored an override
(``ResumeDesign.content``), we wrap the user in a thin proxy that returns the override
values for exactly those attributes and delegates everything else to the real user.

This keeps the override completely isolated to the builder preview / working-template
paths - the per-job AI build never opts in, so tailored résumés keep using the profile.
"""

from __future__ import annotations

from typing import Any

from app.models.resume_design_schemas import ResumeContent

# Attribute names the renderers read straight off the override (same names on both sides).
_DIRECT = {
    "name_first",
    "name_middle",
    "name_last",
    "phone_country_code",
    "phone_number",
    "linkedin_url",
    "github_url",
    "profile_summary",
    "technical_skills",
    "work_experience",
    "education",
    "certificates",
}


class _ContentOverlayUser:
    """Proxy that prefers override content, falling back to the wrapped user."""

    def __init__(self, user: Any, content: dict[str, Any]):
        object.__setattr__(self, "_user", user)
        object.__setattr__(self, "_content", content)

    def __getattr__(self, name: str) -> Any:
        content = object.__getattribute__(self, "_content")
        user = object.__getattribute__(self, "_user")

        # Header title/email use different attribute names on the User model.
        if name in ("profile_title",):
            return content.get("title") or getattr(user, name, None)
        if name in ("profile_email",):
            return content.get("email") or getattr(user, name, None)
        if name == "email":
            return content.get("email") or getattr(user, "email", None)

        if name in _DIRECT:
            value = content.get(name)
            # List sections override as-is (even when emptied on purpose); scalar header
            # fields fall back to the real profile when left blank, so a half-filled
            # Content panel never wipes an otherwise-valid header.
            if isinstance(value, list):
                return value
            if value:
                return value
            return getattr(user, name, None)

        return getattr(user, name)


def apply_content_overlay(user: Any, content: ResumeContent | dict | None) -> Any:
    """Return a user-like object that renders *content* (or the user as-is if no override)."""
    if content is None:
        return user
    data = content.model_dump(mode="json") if isinstance(content, ResumeContent) else dict(content)
    if not _has_any_content(data):
        return user
    return _ContentOverlayUser(user, data)


def _has_any_content(data: dict[str, Any]) -> bool:
    """True if the override carries at least one non-empty field worth applying."""
    for key, value in data.items():
        if isinstance(value, list):
            if value:
                return True
        elif isinstance(value, str):
            if value.strip():
                return True
        elif value:
            return True
    return False
