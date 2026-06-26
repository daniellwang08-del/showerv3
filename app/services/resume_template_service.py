"""Per-user resume template upload, analysis, validation, and lifecycle."""

from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from docx import Document


from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.llm_client import get_llm_client_for_user
from app.models.database import User
from app.models.resume_template_schemas import (
    FieldBinding,
    RepeatBlock,
    ResumeSection,
    ResumeTemplateAiValidation,
    ResumeTemplateBlueprint,
    ResumeTemplateStatusResponse,
)
from app.prompts.resume_template_prompt import (
    RESUME_TEMPLATE_STRUCTURE_INSTRUCTIONS,
    RESUME_TEMPLATE_STRUCTURE_USER_TEMPLATE,
    RESUME_TEMPLATE_VALIDATION_INSTRUCTIONS,
    RESUME_TEMPLATE_VALIDATION_USER_TEMPLATE,
)
from app.services.resume_template_requirements import (
    get_template_requirements,
    resume_style_summary_for_prompt,
)
from app.services.docx_structure import build_document_outline, find_tags_in_document
from app.services.resume_blueprint_renderer import fill_user_resume_template
from app.services.resume_context_builder import build_preview_tailored, build_render_context
from app.storage.database import get_session

logger = get_logger(__name__)

LEGACY_EXP_PATTERN = re.compile(r"\{\{EXP_(\d+)\}\}")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


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

    warnings: list[str] = []
    if engine == "legacy_exp_n":
        exp_count = len([t for t in tags if LEGACY_EXP_PATTERN.search(t)])
        if exp_count:
            warnings.append(f"Fixed-slot template with {exp_count} {{EXP_N}} placeholder(s).")
        else:
            warnings.append(
                "No {{EXP_N}} tags found. Add {{EXP_1}}, {{EXP_2}}, … for each work role (recommended layout)."
            )
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
        warnings.append("Repeat-block template - fixed {{EXP_N}} slots are recommended for layout control.")

    return ResumeTemplateBlueprint(
        engine=engine,  # type: ignore[arg-type]
        sections=sections,
        working_block=None,
        detected_tags=tags,
        warnings=warnings,
    )


def validate_blueprint(
    blueprint: ResumeTemplateBlueprint,
    *,
    profile_work_count: int,
    detected_tags: list[str] | None = None,
) -> list[str]:
    errors: list[str] = []
    tags = detected_tags or blueprint.detected_tags
    uses_legacy = blueprint.engine == "legacy_exp_n" or any(
        LEGACY_EXP_PATTERN.search(t) for t in tags
    )

    if uses_legacy:
        exp_count = len([t for t in tags if LEGACY_EXP_PATTERN.search(t)])
        if exp_count == 0:
            errors.append(
                "Add fixed experience slots {{EXP_1}}, {{EXP_2}}, … - one per role in your profile."
            )
        elif profile_work_count > exp_count:
            errors.append(
                f"Template has {exp_count} slot(s) but profile has {profile_work_count}. "
                f"Add {{{{EXP_{exp_count + 1}}}}} through {{{{EXP_{profile_work_count}}}}}."
            )
        if not any("PROFILE_SUMMARY" in t or "tailored.profile_summary" in t for t in tags):
            errors.append("Missing {{PROFILE_SUMMARY}} placeholder.")
        if profile_work_count <= 0:
            errors.append("Profile has no work experience entries.")
        return errors

    has_summary = any(
        b.path == "tailored.profile_summary"
        for s in blueprint.sections
        for b in s.bindings
    ) or any("PROFILE_SUMMARY" in t or "tailored.profile_summary" in t for t in tags)
    if not has_summary:
        errors.append("Missing summary binding ({{tailored.profile_summary}} or {{PROFILE_SUMMARY}}).")

    has_work = blueprint.working_block is not None or any(s.id == "work_experience" for s in blueprint.sections)
    has_legacy_work = any(LEGACY_EXP_PATTERN.search(t) for t in tags)
    if not has_work and not has_legacy_work:
        errors.append(
            "Missing work experience slots. Add {{EXP_1}}, {{EXP_2}}, … (recommended) "
            "or an optional {{#work_experience}} repeat block."
        )

    if profile_work_count <= 0:
        errors.append("Profile has no work experience entries.")

    return errors


def _detected_template_type(
    blueprint: ResumeTemplateBlueprint,
    detected_tags: list[str],
) -> str:
    if any(LEGACY_EXP_PATTERN.search(t) for t in detected_tags):
        return "legacy_exp_n"
    if blueprint.engine == "blueprint" or any("#work_experience" in t for t in detected_tags):
        return "dynamic"
    return "legacy_exp_n"


def _requirements_summary_for_prompt(profile_work_count: int, user: User | None = None) -> str:
    req = get_template_requirements(user=user, profile_work_count=profile_work_count)
    return resume_style_summary_for_prompt(req)


async def _call_openai_validation(
    outline: str,
    detected_tags: list[str],
    blueprint: ResumeTemplateBlueprint,
    profile_work_count: int,
    user_id: str,
    user: User | None = None,
) -> ResumeTemplateAiValidation | None:
    settings = get_settings()
    client = await get_llm_client_for_user(user_id)
    blueprint_json = blueprint.model_dump(exclude={"ai_validation"})
    user_content = RESUME_TEMPLATE_VALIDATION_USER_TEMPLATE.format(
        requirements_summary=_requirements_summary_for_prompt(profile_work_count, user=user),
        profile_work_count=profile_work_count,
        detected_tags=", ".join(detected_tags) or "(none)",
        outline=outline,
        blueprint_json=json.dumps(blueprint_json, indent=2),
    )
    try:
        response = await client.chat.completions.create(
            model=settings.openai_model,
            messages=[
                {"role": "system", "content": RESUME_TEMPLATE_VALIDATION_INSTRUCTIONS},
                {"role": "user", "content": user_content},
            ],
            response_format={"type": "json_object"},
            temperature=0.1,
            max_tokens=2048,
        )
        text = response.choices[0].message.content
        if not text:
            return None
        parsed = json.loads(text)
        validation = ResumeTemplateAiValidation.model_validate(parsed)
        validation.validated_at = _utcnow()
        return validation
    except Exception as e:
        logger.warning("resume_template_validation_llm_failed", error=str(e))
        return None


def _fallback_validation(
    blueprint: ResumeTemplateBlueprint,
    detected_tags: list[str],
    profile_work_count: int,
    rule_errors: list[str],
) -> ResumeTemplateAiValidation:
    template_type = _detected_template_type(blueprint, detected_tags)
    passed = len(rule_errors) == 0
    summary = (
        "Template passed rule-based validation."
        if passed
        else "Template failed validation: " + "; ".join(rule_errors[:3])
    )
    return ResumeTemplateAiValidation(
        passed=passed,
        template_type=template_type,  # type: ignore[arg-type]
        summary=summary,
        errors=list(rule_errors),
        warnings=list(blueprint.warnings),
        suggestions=(
            []
            if passed
            else ["Review required placeholders in Settings and upload a corrected .docx template."]
        ),
        detected_required_tags=[t for t in detected_tags if "{{" in t],
        missing_required_tags=[],
        validated_at=_utcnow(),
    )


def _merge_validations(
    ai_validation: ResumeTemplateAiValidation | None,
    rule_errors: list[str],
    blueprint: ResumeTemplateBlueprint,
    detected_tags: list[str],
    profile_work_count: int,
) -> ResumeTemplateAiValidation:
    base = ai_validation or _fallback_validation(
        blueprint, detected_tags, profile_work_count, rule_errors
    )
    merged_errors = list(dict.fromkeys([*base.errors, *rule_errors]))
    passed = len(merged_errors) == 0 and base.passed
    summary = base.summary
    if rule_errors and ai_validation and ai_validation.passed:
        summary = (
            "OpenAI validation passed, but rule checks found issues: "
            + "; ".join(rule_errors[:2])
        )
    elif not passed and not summary:
        summary = "Template validation failed."

    return ResumeTemplateAiValidation(
        passed=passed,
        template_type=base.template_type or _detected_template_type(blueprint, detected_tags),  # type: ignore[arg-type]
        summary=summary,
        errors=merged_errors,
        warnings=list(dict.fromkeys([*base.warnings, *blueprint.warnings])),
        suggestions=base.suggestions,
        detected_required_tags=base.detected_required_tags,
        missing_required_tags=base.missing_required_tags,
        validated_at=base.validated_at or _utcnow(),
    )


async def _call_openai_blueprint(
    outline: str,
    detected_tags: list[str],
    profile_work_count: int,
    user_id: str,
) -> ResumeTemplateBlueprint | None:
    settings = get_settings()
    client = await get_llm_client_for_user(user_id)
    user_content = RESUME_TEMPLATE_STRUCTURE_USER_TEMPLATE.format(
        outline=outline,
        detected_tags=", ".join(detected_tags) or "(none)",
        profile_work_count=profile_work_count,
    )
    try:
        response = await client.chat.completions.create(
            model=settings.openai_model,
            messages=[
                {"role": "system", "content": RESUME_TEMPLATE_STRUCTURE_INSTRUCTIONS},
                {"role": "user", "content": user_content},
            ],
            response_format={"type": "json_object"},
            temperature=0.1,
            max_tokens=4096,
        )
        text = response.choices[0].message.content
        if not text:
            return None
        parsed = json.loads(text)
        return ResumeTemplateBlueprint.model_validate(parsed)
    except Exception as e:
        logger.warning("resume_template_llm_failed", error=str(e))
        return None


def _write_working_copy(source_path: Path, user_id: str) -> Path:
    working = user_template_dir(user_id) / "working_template.docx"
    shutil.copy2(source_path, working)
    return working


async def run_template_analysis(user_id: str, reason: str = "upload") -> None:
    async with get_session() as session:
        from app.storage.user_repository import UserRepository

        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            return

        source_path = getattr(user, "resume_template_source_path", None)
        if not source_path or not Path(source_path).exists():
            user.resume_template_status = "failed"
            user.resume_template_error = "Uploaded template file is missing."
            await session.commit()
            return

        user.resume_template_status = "processing"
        user.resume_template_error = None
        await session.commit()

    try:
        async with get_session() as session:
            from app.storage.user_repository import UserRepository

            repo = UserRepository(session)
            user = await repo.get_by_id(user_id)
            if not user:
                return
            profile_work_count = count_work_roles(user)

        doc = Document(str(source_path))
        outline = build_document_outline(doc)
        detected_tags = find_tags_in_document(doc)

        blueprint = await _call_openai_blueprint(outline, detected_tags, profile_work_count, user_id)
        if blueprint is None:
            blueprint = _default_blueprint_from_tags(detected_tags, profile_work_count)

        blueprint.detected_tags = detected_tags
        if any(LEGACY_EXP_PATTERN.search(t) for t in detected_tags):
            blueprint.engine = "legacy_exp_n"
        elif not any("#work_experience" in t for t in detected_tags):
            blueprint.engine = "legacy_exp_n"
        rule_errors = validate_blueprint(
            blueprint,
            profile_work_count=profile_work_count,
            detected_tags=detected_tags,
        )

        ai_validation_raw = await _call_openai_validation(
            outline,
            detected_tags,
            blueprint,
            profile_work_count,
            user_id,
            user=user,
        )
        ai_validation = _merge_validations(
            ai_validation_raw,
            rule_errors,
            blueprint,
            detected_tags,
            profile_work_count,
        )
        blueprint.ai_validation = ai_validation
        validation_errors = ai_validation.errors

        working_path = _write_working_copy(Path(source_path), user_id)

        async with get_session() as session:
            from app.storage.user_repository import UserRepository

            repo = UserRepository(session)
            user = await repo.get_by_id(user_id)
            if not user:
                return
            user.resume_template_working_path = str(working_path)
            user.resume_template_blueprint = _blueprint_for_storage(blueprint)
            user.resume_template_profile_work_count = profile_work_count
            user.resume_template_analyzed_at = _utcnow()
            if validation_errors or not ai_validation.passed:
                user.resume_template_status = "failed"
                user.resume_template_error = ai_validation.summary or "; ".join(validation_errors)
            else:
                user.resume_template_status = "ready"
                user.resume_template_error = None
            await session.commit()
            logger.info(
                "resume_template_analysis_complete",
                user_id=user_id,
                reason=reason,
                status=user.resume_template_status,
            )
    except Exception as e:
        logger.exception("resume_template_analysis_failed", user_id=user_id, error=str(e))
        async with get_session() as session:
            from app.storage.user_repository import UserRepository

            repo = UserRepository(session)
            user = await repo.get_by_id(user_id)
            if user:
                user.resume_template_status = "failed"
                user.resume_template_error = str(e)[:1500]
                await session.commit()


def mark_template_stale_if_work_count_changed(user: User, new_count: int) -> bool:
    status = getattr(user, "resume_template_status", None) or "missing"
    if status not in ("ready", "stale"):
        return False
    old_count = getattr(user, "resume_template_profile_work_count", None)
    if old_count is None or old_count == new_count:
        return False
    user.resume_template_status = "stale"
    user.resume_template_error = (
        f"Profile work experience count changed ({old_count} → {new_count}). Re-analyze template."
    )
    return True


async def save_uploaded_template(user_id: str, raw: bytes, filename: str) -> None:
    settings = get_settings()
    if len(raw) > settings.resume_template_max_bytes:
        raise ValueError(f"File exceeds maximum size of {settings.resume_template_max_bytes} bytes.")
    if not filename.lower().endswith(".docx"):
        raise ValueError("Only .docx files are supported.")

    dest_dir = user_template_dir(user_id)
    safe_name = re.sub(r"[^\w.\- ]", "_", filename)[:200] or "template.docx"
    source_path = dest_dir / safe_name
    source_path.write_bytes(raw)

    async with get_session() as session:
        from app.storage.user_repository import UserRepository

        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise ValueError("User not found")
        user.resume_template_source_path = str(source_path)
        user.resume_template_source_filename = safe_name
        user.resume_template_working_path = None
        user.resume_template_blueprint = None
        user.resume_template_status = "processing"
        user.resume_template_error = None
        user.resume_template_analyzed_at = None
        await session.commit()


async def schedule_template_analysis(user_id: str, reason: str = "upload") -> None:
    from app.tasks.worker import get_analysis_pool

    pool = await get_analysis_pool()
    await pool.enqueue_job("analyze_resume_template", user_id, reason)


def template_status_payload(user: User | None) -> dict[str, Any]:
    profile_work_count = count_work_roles(user) if user else 0
    requirements = get_template_requirements(user=user, profile_work_count=profile_work_count)

    if not user:
        return ResumeTemplateStatusResponse(
            resume_template_status="missing",
            requirements=requirements,
        ).model_dump(mode="json")

    blueprint_raw = getattr(user, "resume_template_blueprint", None) or {}
    blueprint: ResumeTemplateBlueprint | None = None
    sections = []
    detected = []
    warnings = []
    ai_validation: ResumeTemplateAiValidation | None = None
    detected_template_type = None

    if isinstance(blueprint_raw, dict) and blueprint_raw:
        try:
            blueprint = ResumeTemplateBlueprint.model_validate(blueprint_raw)
            sections = blueprint.sections
            detected = blueprint.detected_tags
            warnings = blueprint.warnings
            ai_validation = blueprint.ai_validation
            detected_template_type = _detected_template_type(blueprint, detected)
        except Exception:
            warnings = ["Stored blueprint is invalid. Re-upload template."]

    validation_errors: list[str] = []
    if blueprint:
        validation_errors = validate_blueprint(
            blueprint,
            profile_work_count=profile_work_count,
            detected_tags=detected,
        )
        if ai_validation:
            validation_errors = list(dict.fromkeys([*ai_validation.errors, *validation_errors]))

    status = getattr(user, "resume_template_status", None) or "missing"
    return ResumeTemplateStatusResponse(
        resume_template_status=status,  # type: ignore[arg-type]
        resume_template_source_filename=getattr(user, "resume_template_source_filename", None),
        resume_template_error=getattr(user, "resume_template_error", None),
        resume_template_profile_work_count=getattr(user, "resume_template_profile_work_count", None),
        resume_template_analyzed_at=getattr(user, "resume_template_analyzed_at", None),
        resume_template_ready=user_template_ready_for_build(user),
        sections=sections,
        detected_tags=detected,
        warnings=warnings,
        profile_work_count=profile_work_count,
        validation_errors=validation_errors,
        detected_template_type=detected_template_type,  # type: ignore[arg-type]
        ai_validation=ai_validation,
        requirements=requirements,
    ).model_dump(mode="json")


async def update_user_blueprint(user_id: str, blueprint: ResumeTemplateBlueprint) -> dict[str, Any]:
    async with get_session() as session:
        from app.storage.user_repository import UserRepository

        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise ValueError("User not found")
        profile_work_count = count_work_roles(user)
        errors = validate_blueprint(blueprint, profile_work_count=profile_work_count)
        user.resume_template_blueprint = _blueprint_for_storage(blueprint)
        user.resume_template_profile_work_count = profile_work_count
        if errors:
            user.resume_template_status = "failed"
            user.resume_template_error = "; ".join(errors)
        else:
            user.resume_template_status = "ready"
            user.resume_template_error = None
        user.resume_template_analyzed_at = _utcnow()
        await session.commit()
        user = await repo.get_by_id(user_id)
        return template_status_payload(user)


async def generate_template_preview_docx(user_id: str) -> Path:
    async with get_session() as session:
        from app.storage.user_repository import UserRepository

        repo = UserRepository(session)
        user = await repo.get_by_id(user_id)
        if not user:
            raise ValueError("User not found")
        if not user_template_ready_for_build(user):
            raise ValueError("Template is not ready. Upload and analyze a template first.")
        working_path = Path(user.resume_template_working_path)  # type: ignore[arg-type]
        blueprint = user.resume_template_blueprint
        tailored = build_preview_tailored(user)
        context = build_render_context(user, tailored, job=None)

    preview_path = user_template_dir(user_id) / "preview.docx"
    fill_user_resume_template(working_path, blueprint, context, preview_path)
    return preview_path
