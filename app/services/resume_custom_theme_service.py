"""User-saved resume themes + love markers for the Theme gallery."""

from __future__ import annotations

import uuid
from typing import Any

from app.models.resume_design_schemas import ResumeDesign, ThemePreset
from app.services.resume_themes import THEME_PRESETS
from app.storage.database import get_session
from app.storage.resume_theme_repository import ResumeThemeRepository


def snapshot_design_as_theme(design: ResumeDesign, *, theme_id: str) -> ResumeDesign:
    """Strip content/assets/metrics so a saved theme is pure style chrome."""
    snap = design.model_copy(deep=True)
    snap.theme_id = theme_id
    snap.content = None
    lay = snap.layout
    lay.header_image = None
    lay.header_metrics = None
    lay.layout_metrics = None
    if lay.header_background == "image":
        lay.header_background = "soft"
    return snap


def _preset_from_custom(row, *, is_loved: bool) -> ThemePreset:
    design = ResumeDesign.model_validate(row.design)
    design.theme_id = row.id
    return ThemePreset(
        id=row.id,
        label=row.name,
        description=row.description or "Custom theme",
        accent_swatch=row.accent_swatch or design.colors.accent,
        design=design,
        is_custom=True,
        is_loved=is_loved,
    )


def _sort_themes(themes: list[ThemePreset]) -> list[ThemePreset]:
    """Loved first, then custom (recency already in list order), then built-ins."""
    loved = [t for t in themes if t.is_loved]
    rest = [t for t in themes if not t.is_loved]
    custom = [t for t in rest if t.is_custom]
    builtin = [t for t in rest if not t.is_custom]
    return loved + custom + builtin


async def list_user_themes(user_id: str) -> list[ThemePreset]:
    async with get_session() as session:
        repo = ResumeThemeRepository(session)
        custom_rows = await repo.list_custom(user_id)
        loved = await repo.list_loved_ids(user_id)

    builtins = [
        ThemePreset(
            id=t.id,
            label=t.label,
            description=t.description,
            accent_swatch=t.accent_swatch,
            design=t.design.model_copy(deep=True),
            is_custom=False,
            is_loved=t.id in loved,
        )
        for t in THEME_PRESETS
    ]
    customs = [_preset_from_custom(r, is_loved=r.id in loved) for r in custom_rows]
    return _sort_themes(customs + builtins)


async def save_custom_theme(user_id: str, name: str, design: ResumeDesign) -> dict[str, Any]:
    theme_id = str(uuid.uuid4())
    snap = snapshot_design_as_theme(design, theme_id=theme_id)
    accent = (snap.colors.accent or "#2563eb").strip()
    if not accent.startswith("#"):
        accent = f"#{accent}"
    clean_name = (name or "").strip()[:200] or "Untitled theme"

    async with get_session() as session:
        repo = ResumeThemeRepository(session)
        row = await repo.create_custom(
            id=theme_id,
            user_id=user_id,
            name=clean_name,
            description="Custom theme",
            accent_swatch=accent[:32],
            design=snap.model_dump(mode="json"),
        )
        loved = await repo.list_loved_ids(user_id)
        theme = _preset_from_custom(row, is_loved=row.id in loved)
        await session.commit()

    themes = await list_user_themes(user_id)
    return {"theme": theme, "themes": themes}


async def delete_custom_theme(user_id: str, theme_id: str) -> list[ThemePreset]:
    async with get_session() as session:
        repo = ResumeThemeRepository(session)
        row = await repo.get_custom(theme_id, user_id)
        if not row:
            raise LookupError("Theme not found")
        await repo.delete_custom(row)
        await repo.set_loved(user_id, theme_id, False)
        await session.commit()
    return await list_user_themes(user_id)


async def toggle_theme_love(user_id: str, theme_id: str) -> dict[str, Any]:
    theme_id = (theme_id or "").strip()
    if not theme_id:
        raise ValueError("theme_id required")

    async with get_session() as session:
        repo = ResumeThemeRepository(session)
        builtin_ids = {t.id for t in THEME_PRESETS}
        if theme_id not in builtin_ids:
            custom = await repo.get_custom(theme_id, user_id)
            if not custom:
                raise LookupError("Theme not found")
        currently = await repo.is_loved(user_id, theme_id)
        is_loved = await repo.set_loved(user_id, theme_id, not currently)
        await session.commit()

    themes = await list_user_themes(user_id)
    return {"theme_id": theme_id, "is_loved": is_loved, "themes": themes}
