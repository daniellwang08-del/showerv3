"""Orchestration for the Resume Builder "OneClick AI" center.

Job-less tailoring: the user pastes a raw job description and the assistant routes the
request to the existing match-analysis (Phase A) and tailoring (Phase B) services. No
Job/ValidJob/ResumeBuildResult rows are written — the tailored content is handed back to
the client which injects it straight into the Resume Builder design.
"""

from __future__ import annotations

import json
from typing import Awaitable, Callable

from app.core.config import get_settings
from app.core.llm_client import get_llm_client_for_user
from app.core.logging import get_logger
from app.models.resume_ai_schemas import (
    ResumeAiChatMessage,
    ResumeAiChatResponse,
    ResumeAiMatch,
    ResumeAiTailoredContent,
)
from app.models.resume_design_schemas import ContentSkill, ContentWork
from app.prompts.resume_ai_router_prompt import (
    RESUME_AI_ROUTER_SYSTEM_PROMPT,
    build_router_user_content,
)
from app.services.job_match_service import (
    analyze_job_match_phase_a,
    build_structured_context,
    generate_tailored_content_phase_b,
)
from app.services.profile_evidence_service import extract_job_evidence_pack
from app.storage.database import get_session
from app.storage.user_repository import UserRepository

logger = get_logger(__name__)

# Optional progress reporter: awaited with a small event dict at each pipeline
# stage so the HTTP layer can stream live status to the builder's AI center.
EmitFn = Callable[[dict], Awaitable[None]]


async def _emit(emit: EmitFn | None, stage: str, label: str) -> None:
    if emit is None:
        return
    try:
        await emit({"stage": stage, "label": label})
    except Exception:  # noqa: BLE001 - progress reporting must never break the run
        pass


_ROUTER_HISTORY_TURNS = 6
_ROUTER_MSG_TRUNC = 1500
_JD_MIN_CHARS = 120  # below this a "paste" is treated as chat, not a job posting


def _latest_user_message(messages: list[ResumeAiChatMessage]) -> str:
    for m in reversed(messages):
        if m.role == "user" and (m.content or "").strip():
            return m.content.strip()
    return ""


def _history_text(messages: list[ResumeAiChatMessage]) -> str:
    recent = messages[-_ROUTER_HISTORY_TURNS:]
    lines: list[str] = []
    for m in recent:
        body = (m.content or "").strip()
        if len(body) > _ROUTER_MSG_TRUNC:
            body = body[:_ROUTER_MSG_TRUNC] + " …[truncated]"
        lines.append(f"{m.role}: {body}")
    return "\n".join(lines)


async def _route(user_id: str, messages: list[ResumeAiChatMessage], latest: str) -> dict:
    """Classify intent with a cheap LLM call, with a robust heuristic fallback."""
    try:
        client = await get_llm_client_for_user(user_id)
        settings = get_settings()
        resp = await client.chat.completions.create(
            model=settings.openai_model,
            messages=[
                {"role": "system", "content": RESUME_AI_ROUTER_SYSTEM_PROMPT},
                {"role": "user", "content": build_router_user_content(_history_text(messages), latest)},
            ],
            temperature=0.0,
            max_tokens=400,
            response_format={"type": "json_object"},
        )
        parsed = json.loads(resp.choices[0].message.content or "{}")
        intent = str(parsed.get("intent", "chat")).strip().lower()
        if intent not in {"tailor", "analyze", "refine", "chat"}:
            intent = "chat"
        return {
            "intent": intent,
            "has_job_description": bool(parsed.get("has_job_description", False)),
            "instructions": str(parsed.get("instructions", "") or "").strip(),
            "reply": str(parsed.get("reply", "") or "").strip(),
        }
    except Exception as e:  # noqa: BLE001 - routing must never hard-fail the request
        logger.warning("resume_ai_router_failed", user_id=user_id, error=str(e))
        looks_like_jd = len(latest) >= _JD_MIN_CHARS
        return {
            "intent": "tailor" if looks_like_jd else "chat",
            "has_job_description": looks_like_jd,
            "instructions": "",
            "reply": "",
        }


def _coerce_match(match_result: dict) -> ResumeAiMatch:
    dims_raw = match_result.get("dimension_scores", {}) or {}
    dims: dict[str, int] = {}
    if isinstance(dims_raw, dict):
        for k, v in dims_raw.items():
            try:
                dims[str(k)] = int(round(float(v)))
            except (TypeError, ValueError):
                continue
    return ResumeAiMatch(
        overall_score=int(round(float(match_result.get("overall_score", 0) or 0))),
        recommendation=str(match_result.get("recommendation", "") or ""),
        summary=str(match_result.get("summary", "") or ""),
        strengths=[str(s) for s in (match_result.get("strengths") or []) if str(s).strip()],
        gaps=[str(g) for g in (match_result.get("gaps") or []) if str(g).strip()],
        dimension_scores=dims,
    )


def _map_tailored(tailored: dict) -> ResumeAiTailoredContent:
    skills: list[ContentSkill] = []
    for item in tailored.get("technical_skills", []) or []:
        if isinstance(item, dict):
            cat = str(item.get("category", "") or "").strip()
            vals = str(item.get("skills", "") or "").strip()
            if cat or vals:
                skills.append(ContentSkill(category=cat, skills=vals))

    work: list[ContentWork] = []
    for e in tailored.get("work_experience", []) or []:
        if not isinstance(e, dict):
            continue
        bullets = [b.strip() for b in (e.get("bullets") or []) if isinstance(b, str) and b.strip()]
        work.append(
            ContentWork(
                company_name=str(e.get("company_name", "") or ""),
                job_title=str(e.get("job_title", "") or ""),
                period_start=str(e.get("period_start") or ""),
                period_end=str(e.get("period_end") or ""),
                location=str(e.get("location") or ""),
                job_type="",
                employment_type=str(e.get("employment_type") or ""),
                # Phase B field names differ from the builder content shape.
                project_title=str(e.get("project_name") or ""),
                project_intro=str(e.get("project_description") or ""),
                contributions=bullets,
                used_skills=str(e.get("used_skills") or ""),
                description="",
            )
        )

    return ResumeAiTailoredContent(
        profile_summary=str(tailored.get("profile_summary", "") or ""),
        technical_skills=skills,
        work_experience=work,
    )


async def _run_pipeline(
    user_id: str,
    job_text: str,
    *,
    want_tailor: bool,
    extra_instructions: str = "",
    emit: EmitFn | None = None,
) -> dict:
    """Run Phase A (and optionally Phase B) for a pasted job description. No persistence."""
    async with get_session() as session:
        profile_text = await UserRepository(session).get_profile_openai_text(user_id)
    if not (profile_text or "").strip():
        return {"error": "no_profile"}

    await _emit(emit, "analyzing", "Scoring your match to the role…")
    match_result, structured_job, is_job_posting = await analyze_job_match_phase_a(
        job_text, profile_text, user_id=user_id
    )

    if not is_job_posting:
        return {"is_job_posting": False, "match": match_result}

    out: dict = {
        "is_job_posting": True,
        "match": match_result,
        "job_title": (structured_job.title if structured_job else None),
        "company": (structured_job.company if structured_job else None),
    }
    if not want_tailor:
        return out

    structured_context = build_structured_context(structured_job)
    match_summary = str(match_result.get("summary", "") or "")

    # Project evidence — mirror the per-job pipeline (load inside a session, use after).
    await _emit(emit, "evidence", "Gathering proof from your projects…")
    project_evidence_context = "No project source evidence available."
    async with get_session() as session:
        from app.storage.profile_source_document_repository import ProfileSourceDocumentRepository

        user = await UserRepository(session).get_by_id(user_id)
        source_docs = await ProfileSourceDocumentRepository(session).list_completed_for_user(user_id)
    if user and source_docs:
        try:
            project_evidence_context = await extract_job_evidence_pack(
                job_text=job_text,
                structured_job=structured_job,
                match_summary=match_summary,
                user=user,
                docs=source_docs,
                user_id=user_id,
            )
        except Exception as e:  # noqa: BLE001 - evidence is best-effort
            logger.warning("resume_ai_evidence_failed", user_id=user_id, error=str(e))

    jd_for_phase_b = job_text
    if extra_instructions.strip():
        jd_for_phase_b = (
            f"{job_text}\n\n[Additional tailoring instructions from the candidate — "
            f"apply these while keeping all facts truthful: {extra_instructions.strip()}]"
        )

    await _emit(emit, "tailoring", "Rewriting your resume for this job…")
    tailored_resume, cover_letter = await generate_tailored_content_phase_b(
        jd_for_phase_b,
        profile_text,
        structured_context=structured_context,
        match_summary=match_summary,
        project_evidence_context=project_evidence_context,
        user_id=user_id,
    )
    out["tailored"] = tailored_resume
    out["cover_letter"] = (cover_letter or {}).get("body") if cover_letter else None
    return out


_NO_PROFILE_REPLY = (
    "I couldn't find your profile yet. Add your experience in the Profile page first, "
    "then paste the job description here and I'll tailor your resume to it."
)
_NEED_JD_REPLY = (
    "Paste the full job description and I'll tailor your resume to it — I can also score how "
    "well you match the role."
)
_NOT_A_JOB_REPLY = (
    "That doesn't look like a job posting. Paste the full job description (responsibilities, "
    "requirements, etc.) and I'll tailor your resume to it."
)


async def run_resume_ai_chat(
    user_id: str,
    messages: list[ResumeAiChatMessage],
    last_job_description: str | None,
    emit: EmitFn | None = None,
) -> ResumeAiChatResponse:
    latest = _latest_user_message(messages)
    if not latest:
        return ResumeAiChatResponse(
            reply="Paste a job description and tell me what you'd like — tailor your resume or score your match.",
            intent="chat",
        )

    await _emit(emit, "routing", "Understanding your request…")
    route = await _route(user_id, messages, latest)
    intent = route["intent"]
    instructions = route["instructions"]

    # Resolve the job description to act on.
    job_text: str | None = None
    if route["has_job_description"]:
        job_text = latest
    elif last_job_description and last_job_description.strip():
        job_text = last_job_description.strip()

    if intent == "chat":
        reply = route["reply"] or (
            "I'm your resume tailoring assistant. Paste a job description and I'll tailor your "
            "resume to it, score your match, or refine the result on request."
        )
        return ResumeAiChatResponse(reply=reply, intent="chat", action="none")

    if not job_text:
        return ResumeAiChatResponse(reply=_NEED_JD_REPLY, intent=intent, action="none")

    want_tailor = intent in {"tailor", "refine"}
    try:
        result = await _run_pipeline(
            user_id, job_text, want_tailor=want_tailor, extra_instructions=instructions, emit=emit
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("resume_ai_pipeline_failed", user_id=user_id, error=str(e))
        return ResumeAiChatResponse(
            reply="Something went wrong while processing that. Please try again in a moment.",
            intent=intent,
            action="none",
        )

    if result.get("error") == "no_profile":
        return ResumeAiChatResponse(reply=_NO_PROFILE_REPLY, intent=intent, action="none")
    if result.get("is_job_posting") is False:
        return ResumeAiChatResponse(reply=_NOT_A_JOB_REPLY, intent=intent, action="none")

    match = _coerce_match(result["match"])
    job_title = result.get("job_title")
    company = result.get("company")

    if not want_tailor:
        # analyze-only
        role = " · ".join([p for p in [job_title, company] if p]) or "this role"
        reply = route["reply"] or f"Here's how your profile matches {role}."
        return ResumeAiChatResponse(
            reply=reply,
            intent=intent,
            action="analyzed",
            job_description=job_text,
            job_title=job_title,
            company=company,
            match=match,
        )

    tailored_raw = result.get("tailored")
    if not tailored_raw:
        return ResumeAiChatResponse(
            reply="I analyzed the role but couldn't generate tailored content this time. Please try again.",
            intent=intent,
            action="analyzed",
            job_description=job_text,
            job_title=job_title,
            company=company,
            match=match,
        )

    content = _map_tailored(tailored_raw)
    role = " · ".join([p for p in [job_title, company] if p]) or "the role"
    default_reply = (
        f"Done — I tailored your resume to {role} and loaded it into the builder. "
        "Review and tweak it in the Content tab; your match analysis is below."
    )
    return ResumeAiChatResponse(
        reply=route["reply"] or default_reply,
        intent=intent,
        action="tailored",
        job_description=job_text,
        job_title=job_title,
        company=company,
        content=content,
        cover_letter=result.get("cover_letter"),
        match=match,
    )
