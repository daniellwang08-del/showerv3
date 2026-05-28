"""Blueprint-driven resume DOCX rendering."""

from __future__ import annotations

import re
from copy import deepcopy
from pathlib import Path
from typing import Any

from docx import Document

from app.core.logging import get_logger
from app.models.resume_template_schemas import FieldBinding, RepeatBlock, ResumeTemplateBlueprint
from app.services.docx_structure import (
    body_child_elements,
    find_tags_in_document,
    remove_body_range,
    remove_unresolved_tags,
    replace_tag_in_document,
    slice_body_elements,
)
from app.services.resume_builder_service import (
    _save_docx_preserving_template_layout,
    fill_resume_template,
)
from app.services.resume_context_builder import resolve_context_path

logger = get_logger(__name__)

LEGACY_EXP_PATTERN = re.compile(r"\{\{EXP_(\d+)\}\}")


def _binding_value(context: dict[str, Any], binding: FieldBinding, item: dict[str, Any] | None = None) -> str:
    if binding.path.startswith("profile.") or binding.path.startswith("tailored.") or binding.path.startswith("job."):
        value = resolve_context_path(context, binding.path)
    elif item is not None:
        value = item.get(binding.path)
    else:
        value = resolve_context_path(context, binding.path)
    if value is None:
        return ""
    if isinstance(value, list):
        return ""
    return str(value)


def _apply_scalar_bindings(doc: Document, context: dict[str, Any], bindings: list[FieldBinding]) -> None:
    for binding in bindings:
        value = _binding_value(context, binding)
        replace_tag_in_document(doc, binding.tag, value)


def _render_repeat_block(
    doc: Document,
    block: RepeatBlock,
    items: list[dict[str, Any]],
    context: dict[str, Any],
) -> None:
    template_elements = slice_body_elements(doc, block.start_index, block.end_index)
    if not template_elements:
        return

    anchor_index = max(block.start_index - 1, 0)
    rendered: list = []

    for item in items:
        clone_doc_elements = [deepcopy(el) for el in template_elements]
        temp = Document()
        for el in clone_doc_elements:
            temp.element.body.append(el)
        for binding in block.item_bindings:
            val = _binding_value(context, binding, item)
            replace_tag_in_document(temp, binding.tag, val)
        bullets = item.get("bullets") or []
        if bullets:
            if "{{#bullets}}" in find_tags_in_document(temp):
                # simple bullets loop: duplicate block between open/close once per bullet
                pass
            replace_tag_in_document(temp, "{{#bullets}}", "")
            replace_tag_in_document(temp, "{{/bullets}}", "")
            bullet_val = "\n".join(f"• {b}" for b in bullets if str(b).strip())
            replace_tag_in_document(temp, "{{bullet}}", bullet_val)
        for binding in block.item_bindings:
            replace_tag_in_document(temp, binding.tag, _binding_value(context, binding, item))
        rendered.extend(list(temp.element.body))

    remove_body_range(doc, block.start_index, block.end_index)
    body = doc.element.body
    children = list(body)
    if not children:
        return
    anchor = children[min(anchor_index, len(children) - 1)]
    cursor = anchor
    for el in rendered:
        cursor.addnext(el)
        cursor = el


def _render_skills_legacy(doc: Document, context: dict[str, Any]) -> None:
    from app.services.resume_builder_service import _build_skills_elements, _find_paragraph_with_tag, _replace_tag_with_paragraphs

    skills = resolve_context_path(context, "tailored.technical_skills") or []
    anchor = _find_paragraph_with_tag(doc, "{{SKILLS_CONTENT}}")
    if anchor and skills:
        elements = _build_skills_elements(skills, anchor._p)
        _replace_tag_with_paragraphs(doc, "{{SKILLS_CONTENT}}", elements)


def fill_user_resume_template(
    template_path: Path,
    blueprint: ResumeTemplateBlueprint | dict,
    context: dict[str, Any],
    output_path: Path,
) -> Path:
    """Render a user template using blueprint metadata and merged context."""
    if isinstance(blueprint, dict):
        bp = ResumeTemplateBlueprint.model_validate(blueprint)
    else:
        bp = blueprint

    if bp.engine == "legacy_exp_n" or any(LEGACY_EXP_PATTERN.search(t) for t in bp.detected_tags):
        tailored = {
            "profile_summary": resolve_context_path(context, "tailored.profile_summary"),
            "technical_skills": resolve_context_path(context, "tailored.technical_skills") or [],
            "work_experience": resolve_context_path(context, "tailored.work_experience") or [],
        }
        return fill_resume_template(template_path, output_path, tailored)

    doc = Document(str(template_path))

    for section in bp.sections:
        if section.type == "scalar":
            _apply_scalar_bindings(doc, context, section.bindings)
        elif section.type == "repeat" and section.repeat:
            path = section.repeat.item_bindings[0].path if section.repeat.item_bindings else ""
            if "skills" in section.id or "SKILLS" in str(section.bindings):
                items = resolve_context_path(context, "tailored.technical_skills") or []
            else:
                items = resolve_context_path(context, "tailored.work_experience") or []
            if isinstance(items, list) and items:
                _render_repeat_block(doc, section.repeat, items, context)
        elif section.type == "static":
            _apply_scalar_bindings(doc, context, section.bindings)

    if bp.working_block and not any(s.repeat for s in bp.sections if s.id == "work_experience"):
        items = resolve_context_path(context, "tailored.work_experience") or []
        if isinstance(items, list) and items:
            _render_repeat_block(doc, bp.working_block, items, context)

    _apply_scalar_bindings(
        doc,
        context,
        [
            FieldBinding(tag="{{PROFILE_SUMMARY}}", path="tailored.profile_summary", label="Summary"),
            FieldBinding(tag="{{tailored.profile_summary}}", path="tailored.profile_summary", label="Summary"),
            FieldBinding(tag="{{profile.full_name}}", path="profile.full_name", label="Name"),
            FieldBinding(tag="{{profile.email}}", path="profile.email", label="Email"),
            FieldBinding(tag="{{profile.phone}}", path="profile.phone", label="Phone"),
            FieldBinding(tag="{{profile.linkedin}}", path="profile.linkedin", label="LinkedIn"),
            FieldBinding(tag="{{profile.github}}", path="profile.github", label="GitHub"),
            FieldBinding(tag="{{profile.title}}", path="profile.title", label="Title"),
            FieldBinding(tag="{{job.company}}", path="job.company", label="Company"),
            FieldBinding(tag="{{job.title}}", path="job.title", label="Job title"),
        ],
    )
    _render_skills_legacy(doc, context)

    leftover = remove_unresolved_tags(doc)
    if leftover:
        logger.warning("resume_template_unresolved_tags", tags=leftover[:10])

    output_path.parent.mkdir(parents=True, exist_ok=True)
    _save_docx_preserving_template_layout(doc, template_path, output_path)
    logger.info("user_resume_docx_created", path=str(output_path))
    return output_path
