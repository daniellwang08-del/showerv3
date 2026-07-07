"""Shared resume-template helpers for the Resume Builder design pipeline.

The uploaded-.docx-template feature (upload/analyze/validate) has been removed; every
résumé is now compiled from the user's Resume Builder design. The helpers kept here are
shared by the design compiler (``_default_blueprint_from_tags``, ``count_work_roles``),
the design service, and the per-user template directory layout.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from app.core.config import get_settings
from app.core.logging import get_logger
from app.models.database import User
from app.models.resume_template_schemas import (
    FieldBinding,
    RepeatBlock,
    ResumeSection,
    ResumeTemplateBlueprint,
    ResumeTemplateStatusResponse,
)

logger = get_logger(__name__)

LEGACY_EXP_PATTERN = re.compile(r"\{\{EXP_(\d+)\}\}")


def _blueprint_for_storage(blueprint: ResumeTemplateBlueprint) -> dict[str, Any]:
    """JSON-safe blueprint dict for SQLAlchemy JSON columns."""
    return blueprint.model_dump(mode="json")


def count_work_roles(user: User | None) -> int:
    if not user:
        return 0
    count = 0
    for item in getattr(user, "work_experience", None) or []:
        if isinstance(item, dict) and ((item.get("company_name") or "").strip() or (item.get("job_title") or "").strip()):
            count += 1
    return count


def user_template_ready_for_build(user: User | None) -> bool:
    """A résumé can always be built from the design (default theme if unsaved); we only
    report ``ready`` once the user has a saved/compiled working template on disk."""
    if not user:
        return False
    status = getattr(user, "resume_template_status", None) or "missing"
    if status != "ready":
        return False
    working = getattr(user, "resume_template_working_path", None)
    blueprint = getattr(user, "resume_template_blueprint", None)
    if not working or not blueprint:
        return False
    return Path(working).exists()


def user_template_dir(user_id: str) -> Path:
    root = Path(get_settings().user_templates_root)
    path = root / user_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def _default_blueprint_from_tags(tags: list[str], profile_work_count: int) -> ResumeTemplateBlueprint:
    """Build a legacy ``{{EXP_N}}`` blueprint for the tags emitted by ``compile_design``."""
    has_exp = any(LEGACY_EXP_PATTERN.search(t) for t in tags)
    has_loop = any("#work_experience" in t for t in tags)
    engine: str = "legacy_exp_n"
    if has_loop and not has_exp:
        engine = "blueprint"

    sections: list[ResumeSection] = []
    if any("PROFILE_SUMMARY" in t or "tailored.profile_summary" in t for t in tags):
        sections.append(
            ResumeSection(
                id="summary",
                label="Professional Summary",
                type="scalar",
                bindings=[
                    FieldBinding(tag="{{PROFILE_SUMMARY}}", path="tailored.profile_summary"),
                    FieldBinding(tag="{{tailored.profile_summary}}", path="tailored.profile_summary"),
                ],
            )
        )
    if any("SKILLS" in t or "technical_skills" in t for t in tags):
        sections.append(
            ResumeSection(
                id="skills",
                label="Technical Skills",
                type="scalar",
                bindings=[FieldBinding(tag="{{SKILLS_CONTENT}}", path="tailored.technical_skills")],
            )
        )

    if engine == "legacy_exp_n":
        sections.append(
            ResumeSection(
                id="work_experience",
                label="Work Experience (fixed slots)",
                type="static",
                bindings=[
                    FieldBinding(
                        tag=f"{{{{EXP_{i}}}}}",
                        path="tailored.work_experience",
                        label=f"Slot {i}",
                    )
                    for i in sorted(
                        int(LEGACY_EXP_PATTERN.search(t).group(1))
                        for t in tags
                        if LEGACY_EXP_PATTERN.search(t)
                    )
                ],
            )
        )
    elif engine == "blueprint":
        sections.append(
            ResumeSection(
                id="work_experience",
                label="Work Experience",
                type="repeat",
                repeat=RepeatBlock(
                    loop_open_tag="{{#work_experience}}",
                    loop_close_tag="{{/work_experience}}",
                    start_index=0,
                    end_index=0,
                    item_bindings=[
                        FieldBinding(tag="{{company_name}}", path="company_name"),
                        FieldBinding(tag="{{job_title}}", path="job_title"),
                        FieldBinding(tag="{{project_description}}", path="project_description"),
                    ],
                ),
            )
        )

    return ResumeTemplateBlueprint(
        engine=engine,  # type: ignore[arg-type]
        sections=sections,
        working_block=None,
        detected_tags=tags,
        warnings=[],
    )


def template_status_payload(user: User | None) -> dict[str, Any]:
    """Lightweight design-readiness status for the settings + builder-save responses."""
    profile_work_count = count_work_roles(user) if user else 0
    if not user:
        return ResumeTemplateStatusResponse(
            resume_template_status="missing",
            profile_work_count=0,
        ).model_dump(mode="json")

    status = getattr(user, "resume_template_status", None) or "missing"
    return ResumeTemplateStatusResponse(
        resume_template_status=status,  # type: ignore[arg-type]
        resume_template_error=getattr(user, "resume_template_error", None),
        resume_template_profile_work_count=profile_work_count,
        resume_template_ready=user_template_ready_for_build(user),
        profile_work_count=profile_work_count,
    ).model_dump(mode="json")
