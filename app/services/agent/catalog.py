"""Concrete agent tools.

Each tool is a thin adapter over an existing FastAPI route coroutine (or
service), invoked with a synthetic ``current_user`` dict built from the
server-injected :class:`ToolContext`. Reusing the route handlers guarantees the
agent's behaviour stays identical to the human-facing UI and inherits all of its
validation, permissions and side effects.
"""

from __future__ import annotations

import re
from typing import Any

from app.core.logging import get_logger
from app.services.agent.base import (
    ToolContext,
    ToolParam,
    ToolResult,
    ToolSpec,
    register_tool,
)

logger = get_logger(__name__)

# Compact subset of job fields surfaced to the model + rendered as result cards.
_JOB_CARD_KEYS = (
    "id",
    "title",
    "company",
    "location",
    "source",
    "source_url",
    "match_overall_score",
    "applied_at",
    "extraction_status",
    "is_remote",
    "user_status",
    "posted_date",
)


def _cu(ctx: ToolContext) -> dict[str, Any]:
    return {"user_id": ctx.user_id, "is_admin": bool(ctx.is_admin)}


def _job_card(dumped: dict[str, Any]) -> dict[str, Any]:
    return {k: dumped.get(k) for k in _JOB_CARD_KEYS if k in dumped}


async def _run_background_tasks(bt: Any) -> None:
    """Execute tasks a route handler queued on a FastAPI ``BackgroundTasks``.

    When we call a route coroutine directly (outside the request lifecycle)
    FastAPI never flushes its background tasks, so we run them ourselves.
    """
    for task in getattr(bt, "tasks", []) or []:
        try:
            await task()
        except Exception as exc:  # noqa: BLE001 - best-effort, mirror route behaviour
            logger.warning("agent_background_task_failed", error=str(exc)[:200])


# ── Dashboard control (drives the main jobs table, not the chat) ───────────

_VIEWS = {
    "all",
    "today",
    "mine",
    "suggested",
    "applied",
    "applied_today",
    "available",
    "ready",
    "sheet_posted",
    "pumble_posted",
}
_SORTS = {"created_at", "match_score", "posted_date", "title", "company", "updated_at"}
_VIEW_LABELS = {
    "all": "all jobs",
    "today": "today's new jobs",
    "mine": "jobs you posted",
    "suggested": "suggested jobs (match score filter)",
    "applied": "applied jobs",
    "applied_today": "jobs applied today",
    "available": "upcoming jobs (JD ready, pipeline incomplete)",
    "ready": "ready-to-apply jobs",
    "sheet_posted": "jobs in Google Sheets",
    "pumble_posted": "jobs in Pumble",
}


def _describe_dashboard(filters: dict[str, Any]) -> str:
    if filters.get("reset") and len(filters) == 1:
        return "Cleared all filters - showing all jobs in the dashboard."

    bits: list[str] = []
    if filters.get("remote_only"):
        bits.append("remote")
    if filters.get("query"):
        bits.append(f"matching “{filters['query']}”")
    if filters.get("title"):
        bits.append(f"with title “{filters['title']}”")
    if filters.get("company"):
        bits.append(f"at “{filters['company']}”")
    if filters.get("source"):
        bits.append(f"from {filters['source']}")

    scope = _VIEW_LABELS.get(filters.get("view", ""), "jobs")
    if filters.get("view") in {None, "", "all"} and bits:
        scope = "jobs"

    parts = [scope] + bits
    summary = "Showing " + " ".join(parts).replace("jobs jobs", "jobs")
    if filters.get("sort"):
        order = "ascending" if filters.get("order") == "asc" else "descending"
        sort_label = "match score" if filters["sort"] == "match_score" else filters["sort"].replace("_", " ")
        summary += f", sorted by {sort_label} ({order})"
    return summary + " in the dashboard."


async def _update_dashboard(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    """Apply view/filter/sort changes to the user's main jobs table."""
    filters: dict[str, Any] = {}

    if bool(args.get("reset", False)):
        filters["reset"] = True

    view = str(args.get("view") or "").strip().lower()
    if view in _VIEWS:
        filters["view"] = view

    if args.get("remote_only") is not None:
        filters["remote_only"] = bool(args["remote_only"])

    for key in ("source", "query", "title", "company"):
        val = args.get(key)
        if val is not None and str(val).strip():
            filters[key] = str(val).strip()

    sort = str(args.get("sort") or "").strip().lower()
    if sort in _SORTS:
        filters["sort"] = sort
    order = str(args.get("order") or "").strip().lower()
    if order in {"asc", "desc"}:
        filters["order"] = order

    if not filters:
        return ToolResult(
            ok=False,
            summary="No dashboard changes were specified.",
            error="empty filters",
        )

    summary = _describe_dashboard(filters)
    return ToolResult(
        ok=True,
        summary=summary,
        data={"ui_action": {"action": "update_dashboard", "filters": filters, "summary": summary}},
    )


# ── Read tools (auto-run) ──────────────────────────────────────────────────


async def _search_jobs(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    from app.api.routes import get_dashboard_jobs

    try:
        limit = int(args.get("limit") or 20)
    except (TypeError, ValueError):
        limit = 20
    limit = max(1, min(limit, 50))

    view = str(args.get("view") or "all").strip().lower()
    if view not in {
        "all",
        "today",
        "mine",
        "suggested",
        "applied",
        "applied_today",
        "available",
        "ready",
        "sheet_posted",
        "pumble_posted",
    }:
        view = "all"

    page = await get_dashboard_jobs(
        page=1,
        per_page=limit,
        sort=str(args.get("sort") or "created_at"),
        order=str(args.get("order") or "desc"),
        q=args.get("query") or None,
        title=args.get("title") or None,
        company=args.get("company") or None,
        source=args.get("source") or None,
        remote_only=bool(args.get("remote_only", False)),
        view=view,
        timezone=ctx.timezone,
        current_user=_cu(ctx),
    )
    dumped = page.model_dump()
    jobs = [_job_card(it) for it in dumped.get("items", [])]
    total = dumped.get("total", len(jobs))
    shown = len(jobs)
    summary = (
        f"Found {total} matching job(s)"
        + (f"; showing the first {shown}." if total > shown else ".")
    )
    return ToolResult(
        ok=True,
        summary=summary,
        data={"total": total, "shown": shown, "jobs": jobs},
    )


async def _get_stats(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    from app.api.scraper_routes import get_scraper_stats

    resp = await get_scraper_stats(_cu(ctx), ctx.timezone)
    d = resp.model_dump()
    d.pop("sources", None)
    d.pop("recent_runs", None)
    summary = (
        f"{d.get('total_jobs', 0)} total jobs, "
        f"{d.get('today_scraped', 0)} added today, "
        f"{d.get('ready_jobs', 0)} ready to apply, "
        f"{d.get('best_jobs', 0)} strong / {d.get('good_jobs', 0)} good matches, "
        f"avg score {d.get('avg_match_score', 0)}, "
        f"{d.get('applied_jobs', 0)} applied ({d.get('applied_today', 0)} today), "
        f"{d.get('sheet_posted_jobs', 0)} in Sheets, "
        f"{d.get('pumble_posted_jobs', 0)} in Pumble, "
        f"{d.get('available_jobs', 0)} upcoming (JD ready, pipeline incomplete)."
    )
    return ToolResult(ok=True, summary=summary, data=d)


async def _get_sync_status(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    from app.api.scraper_routes import get_sync_status

    resp = await get_sync_status(_cu(ctx))
    d = resp.model_dump()
    return ToolResult(
        ok=True,
        summary=f"Sync status: {d.get('status', 'unknown')}.",
        data=d,
    )


async def _get_job_details(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    from fastapi import HTTPException

    from app.api.routes import get_valid_job

    job_id = str(args.get("job_id") or "").strip()
    if not job_id:
        return ToolResult(ok=False, summary="A job_id is required.", error="missing job_id")
    try:
        resp = await get_valid_job(job_id, _cu(ctx))
    except HTTPException as exc:
        return ToolResult(ok=False, summary=str(exc.detail), error=str(exc.detail))
    d = resp.model_dump()
    return ToolResult(
        ok=True,
        summary=f"{d.get('title') or 'Job'} at {d.get('company') or 'Unknown'}.",
        data=d,
    )


# ── Action tools (confirmation-gated) ──────────────────────────────────────


async def _submit_job(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    from fastapi import BackgroundTasks

    from app.api.routes import submit_job as submit_job_route
    from app.models.schemas import JobSubmissionRequest

    url = str(args.get("url") or "").strip()
    if not url:
        return ToolResult(ok=False, summary="A job URL is required.", error="missing url")

    bt = BackgroundTasks()
    req = JobSubmissionRequest(url=url)
    resp = await submit_job_route(req, bt, _cu(ctx))
    await _run_background_tasks(bt)
    d = resp.model_dump()
    if d.get("success") and d.get("job_id") and not d.get("is_duplicate"):
        from app.services.job_add_batches import record_job_add

        await record_job_add(ctx.user_id, [d["job_id"]], source="manual")
    return ToolResult(
        ok=bool(d.get("success")),
        summary=d.get("message") or "Job submitted.",
        data=d,
        refresh=["jobs", "stats"],
    )


async def _set_applied(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    from app.api.routes import (
        mark_valid_jobs_applied_batch,
        mark_valid_jobs_unapplied_batch,
    )
    from app.models.schemas import JobIdsBatchRequest

    job_ids = [str(j) for j in (args.get("job_ids") or []) if str(j).strip()]
    if not job_ids:
        return ToolResult(ok=False, summary="No job_ids provided.", error="missing job_ids")
    applied = bool(args.get("applied", True))

    req = JobIdsBatchRequest(job_ids=job_ids)
    if applied:
        res = await mark_valid_jobs_applied_batch(req, _cu(ctx))
        summary = f"Marked {res.get('marked', 0)} job(s) as applied."
    else:
        res = await mark_valid_jobs_unapplied_batch(req, _cu(ctx))
        summary = f"Cleared the applied mark on {res.get('cleared', 0)} job(s)."
    return ToolResult(ok=True, summary=summary, data=res, refresh=["jobs", "stats"])


async def _rerun_matches(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    from fastapi import BackgroundTasks

    from app.api.routes import RerunJobMatchBatchRequest, rerun_job_match_batch

    job_ids = [str(j) for j in (args.get("job_ids") or []) if str(j).strip()]
    if not job_ids:
        return ToolResult(ok=False, summary="No job_ids provided.", error="missing job_ids")

    bt = BackgroundTasks()
    req = RerunJobMatchBatchRequest(job_ids=job_ids)
    res = await rerun_job_match_batch(req, bt, _cu(ctx))
    await _run_background_tasks(bt)
    enqueued = res.get("enqueued", 0) if isinstance(res, dict) else 0
    return ToolResult(
        ok=True,
        summary=f"Re-queued AI match analysis for {enqueued} job(s).",
        data=res,
        refresh=["jobs", "stats"],
    )


async def _trigger_sync(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    from fastapi import HTTPException

    from app.api.scraper_routes import SyncRequest, trigger_sync

    if not ctx.is_admin:
        return ToolResult(
            ok=False,
            summary="Only admins can sync jobs.",
            error="Admin access required",
        )

    platforms = [str(p).strip() for p in (args.get("platforms") or []) if str(p).strip()]
    if platforms:
        spider_name = platforms[0] if len(platforms) == 1 else "all"
        spider_names = platforms
    else:
        spider_name, spider_names = "all", None

    try:
        req = SyncRequest(
            spider_name=spider_name,
            spider_names=spider_names,
            sync_mode="incremental",
        )
        resp = await trigger_sync(req, _cu(ctx))
    except HTTPException as exc:
        return ToolResult(ok=False, summary=str(exc.detail), error=str(exc.detail))
    d = resp.model_dump()
    return ToolResult(
        ok=True,
        summary=d.get("message") or "Sync queued.",
        data=d,
        refresh=["sync"],
    )


# ── Documents ──────────────────────────────────────────────────────────────

_MIN_JD_CHARS = 200


def _job_description_from(ctx: ToolContext, args: dict[str, Any]) -> str:
    """Prefer the user's own pasted text over anything the model re-typed."""
    for text in (ctx.user_message, *ctx.earlier_user_messages):
        if len((text or "").strip()) >= _MIN_JD_CHARS:
            return text.strip()
    typed = str(args.get("job_description") or "").strip()
    return typed if len(typed) >= _MIN_JD_CHARS else ""


_REQUEST_LINE_RE = re.compile(
    r"\b(tailor\w*|customi[sz]e|rewrite|generate|create|write|make|build|prepare|draft)\b"
    r".{0,80}\b(resume|r\u00e9sum\u00e9|cv|cover\s+letter)\b",
    re.IGNORECASE,
)


def posting_without_request(text: str) -> str:
    """The pasted posting without a short leading or trailing request ("tailor my resume to this")."""
    parts = re.split(r"\n\s*\n", (text or "").strip())
    if len(parts) > 1 and len(parts[0]) <= 240 and _REQUEST_LINE_RE.search(parts[0]):
        parts = parts[1:]
    if len(parts) > 1 and len(parts[-1]) <= 240 and _REQUEST_LINE_RE.search(parts[-1]):
        parts = parts[:-1]
    return "\n\n".join(parts).strip()


def _truthy(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y"}
    return bool(value)


class TailorChecklist:
    """Step list streamed with every ``progress`` event of ``tailor_resume``.

    Pipeline stages arrive in order; a stage marks every earlier step done.
    Writing the resume and the cover letter run in parallel, so both are
    active together.
    """

    # Typical run on gpt-5.1: scoring and evidence ~15 s, writing ~60 s.
    EXPECTED_SECONDS = 90
    _STAGE_STEPS = {
        "reading": ("read",),
        "analyzing": ("score",),
        "evidence": ("evidence",),
        "tailoring": ("resume", "cover_letter"),
        "quality": ("quality",),
        "saving": ("save",),
    }

    def __init__(self, ctx: ToolContext, include_letter: bool):
        self._ctx = ctx
        labels = [
            ("read", "Reading the job description"),
            ("score", "Scoring your match to the role"),
            ("evidence", "Gathering evidence from your projects"),
            ("resume", "Writing your tailored resume"),
        ]
        if include_letter:
            labels.append(("cover_letter", "Writing your cover letter"))
        labels += [
            ("quality", "Checking quality"),
            ("save", "Saving to Documents"),
        ]
        self.steps = [{"id": i, "label": label, "status": "pending"} for i, label in labels]

    def _index(self, step_id: str) -> int:
        return next((n for n, s in enumerate(self.steps) if s["id"] == step_id), -1)

    async def _push(self) -> None:
        active = [s["label"] for s in self.steps if s["status"] == "active"]
        label = active[0] if active else "Tailoring your resume"
        await self._ctx.report(
            label,
            steps=[dict(s) for s in self.steps],
            expected_seconds=self.EXPECTED_SECONDS,
        )

    async def stage(self, stage: str) -> None:
        ids = [i for i in self._STAGE_STEPS.get(stage, ()) if self._index(i) >= 0]
        if not ids:
            return
        first = min(self._index(i) for i in ids)
        for n, s in enumerate(self.steps):
            if n < first and s["status"] != "done":
                s["status"] = "done"
            elif s["id"] in ids:
                s["status"] = "active"
        await self._push()

    async def finish(self) -> None:
        for s in self.steps:
            s["status"] = "done"
        await self._push()

    async def fail(self) -> None:
        for s in self.steps:
            if s["status"] == "active":
                s["status"] = "failed"
        await self._push()


async def _tailor_resume(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    from app.core.llm_client import llm_failure_message
    from app.services.resume_ai_chat_service import _run_pipeline
    from app.services.resume_design_service import save_ai_tailored_as_library_resume

    job_text = _job_description_from(ctx, args)
    if not job_text:
        return ToolResult(
            ok=False,
            summary="Paste the full job description in your message, then ask again.",
            error="missing job description",
        )
    include_letter = _truthy(args.get("include_cover_letter", False))
    instructions = str(args.get("instructions") or "").strip()[:2000]
    steps = TailorChecklist(ctx, include_letter)

    async def emit(ev: dict[str, Any]) -> None:
        await steps.stage(str(ev.get("stage") or ""))

    try:
        out = await _run_pipeline(
            ctx.user_id,
            job_text,
            want_tailor=True,
            extra_instructions=instructions,
            emit=emit,
            want_cover_letter=include_letter,
            free_scoring=True,
        )
    except Exception as exc:  # noqa: BLE001 - report the provider reason, keep the turn alive
        logger.warning("agent_tailor_failed", user_id=ctx.user_id, error=str(exc)[:300])
        message = llm_failure_message(exc, feature="Tailoring")
        await steps.fail()
        return ToolResult(ok=False, summary=message, error=message)

    if out.get("error") == "no_profile":
        await steps.fail()
        return ToolResult(
            ok=False,
            summary="Add your experience on the Profile page first, then try again.",
            error="no_profile",
        )
    if not out.get("is_job_posting"):
        await steps.fail()
        return ToolResult(
            ok=False,
            summary="That text doesn't read like a job description. Paste the full posting and try again.",
            error="not_a_job_posting",
        )
    tailored = out.get("tailored")
    if not isinstance(tailored, dict) or not tailored:
        await steps.fail()
        return ToolResult(ok=False, summary="The AI returned no tailored content. Please try again.", error="empty")

    letter = (out.get("cover_letter") or "").strip() if include_letter else ""
    match = out.get("match") or {}
    score = match.get("overall_score", match.get("score")) if isinstance(match, dict) else None
    if not isinstance(score, (int, float)):
        score = None
    await steps.stage("saving")
    payload = await save_ai_tailored_as_library_resume(
        ctx.user_id,
        content=tailored,
        job_title=out.get("job_title"),
        company=out.get("company"),
        activate=False,
        cover_letter=letter or None,
        job_description=posting_without_request(job_text) or job_text,
        match_score=score,
        origin="assistant",
    )
    await steps.finish()
    resume = payload.get("resume") or {}
    role = " at ".join(p for p in (out.get("job_title"), out.get("company")) if p) or "this role"
    saved = "resume and cover letter" if letter else "resume"
    summary = f"Saved a tailored {saved} for {role} to Documents, with the job description."
    if score is not None:
        summary += f" Match score {round(score)}."
    if include_letter and not letter:
        summary += " The cover letter could not be written this time."
    return ToolResult(
        ok=True,
        summary=summary,
        data={
            "document": {
                "resume_id": resume.get("id"),
                "name": resume.get("name"),
                "job_title": out.get("job_title"),
                "company": out.get("company"),
                "has_cover_letter": bool(letter),
                "has_job_description": True,
                "match_score": round(score) if score is not None else None,
            }
        },
        refresh=["documents"],
    )


# ── Registration ───────────────────────────────────────────────────────────

AGENT_TOOLS: list[ToolSpec] = [
    register_tool(
        ToolSpec(
            name="tailor_resume",
            description=(
                "Tailor the user's resume (and optionally a cover letter) to a job description they "
                "pasted, then save it to their Documents. Use for 'tailor my resume to this job', "
                "'write a cover letter for this role', or a pasted posting with a tailoring request."
            ),
            params=[
                ToolParam("include_cover_letter", "boolean", "also save a cover letter (default false)"),
                ToolParam("instructions", "string", "extra wishes, e.g. 'emphasise Python integrations'"),
            ],
            handler=_tailor_resume,
            running_title="Tailoring your resume",
            label="Tailor resume",
            category="Resume and cover letter",
            example="Tailor my resume to this job description:",
        )
    ),
    register_tool(
        ToolSpec(
            name="update_dashboard",
            description=(
                "Drive the MAIN jobs table the user is looking at: change the view tab, "
                "filter (remote, title, company, source, keywords) and sort. Use this whenever "
                "the user wants to SEE / DISPLAY / SHOW / FILTER / SORT / BROWSE jobs (e.g. "
                "'display all remote jobs', 'show today's jobs', 'sort by match score', "
                "'clear filters'). Results appear in the dashboard, NOT the chat."
            ),
            params=[
                ToolParam(
                    "view",
                    "string",
                    "view tab: all, today, mine, suggested, applied, available, ready, sheet_posted, pumble_posted",
                ),
                ToolParam("remote_only", "boolean", "show only remote jobs"),
                ToolParam("query", "string", "free-text keyword filter"),
                ToolParam("title", "string", "filter by job title substring"),
                ToolParam("company", "string", "filter by company substring"),
                ToolParam("source", "string", "platform/source name"),
                ToolParam("sort", "string", "created_at | match_score | posted_date | title | company | updated_at"),
                ToolParam("order", "string", "asc | desc"),
                ToolParam("reset", "boolean", "clear all filters back to defaults first"),
            ],
            handler=_update_dashboard,
            running_title="Updating dashboard",
            label="Filter and sort jobs",
            category="Jobs",
            example="Show today's remote jobs sorted by match score",
        )
    ),
    register_tool(
        ToolSpec(
            name="search_jobs",
            description=(
                "Look up jobs to ANSWER a question in chat or to get job ids needed for a "
                "follow-up action (apply, re-run, details). Does NOT change the dashboard. "
                "Prefer update_dashboard when the user just wants to view/filter jobs."
            ),
            params=[
                ToolParam("query", "string", "free-text keywords across title/company/description"),
                ToolParam("title", "string", "filter by job title substring"),
                ToolParam("company", "string", "filter by company substring"),
                ToolParam("source", "string", "platform/source name (e.g. linkedin, adzuna)"),
                ToolParam("remote_only", "boolean", "only remote jobs"),
                ToolParam(
                    "view",
                    "string",
                    "one of: all, today, mine, suggested, applied, available, ready, sheet_posted, pumble_posted",
                ),
                ToolParam("sort", "string", "created_at | match_score | posted_date | title | company"),
                ToolParam("order", "string", "asc | desc"),
                ToolParam("limit", "number", "max jobs to return (1-50, default 20)"),
            ],
            handler=_search_jobs,
            running_title="Searching jobs",
            label="Find jobs",
            category="Jobs",
            example="Which jobs at fintech companies match me best?",
        )
    ),
    register_tool(
        ToolSpec(
            name="get_stats",
            description="Get aggregate dashboard statistics (totals, today, remote, extracted, ready, posted-by-me).",
            params=[],
            handler=_get_stats,
            running_title="Reading stats",
            label="Search stats",
            category="Insights",
            example="How is my job search going this week?",
        )
    ),
    register_tool(
        ToolSpec(
            name="get_sync_status",
            description="Check whether a scraper sync is currently running and its progress.",
            params=[],
            handler=_get_sync_status,
            running_title="Checking sync status",
            label="Sync status",
            category="Insights",
            example="Is a job sync running right now?",
        )
    ),
    register_tool(
        ToolSpec(
            name="get_job_details",
            description="Get the full details of a single job by id (description, extraction, applied status).",
            params=[ToolParam("job_id", "string", "the job id", required=True)],
            handler=_get_job_details,
            running_title="Loading job",
            label="Job details",
            category="Jobs",
            example="Tell me more about my top match",
        )
    ),
    register_tool(
        ToolSpec(
            name="submit_job",
            description="Submit a job posting URL to add it to the user's pool (queues extraction + analysis).",
            params=[ToolParam("url", "string", "the job posting URL", required=True)],
            handler=_submit_job,
            requires_confirmation=True,
            running_title="Submitting job",
            label="Add a job by link",
            category="Jobs",
            example="Add this job: https://",
        )
    ),
    register_tool(
        ToolSpec(
            name="set_applied",
            description="Mark one or more jobs as applied (applied=true) or clear the applied mark (applied=false).",
            params=[
                ToolParam("job_ids", "string[]", "job ids to update", required=True),
                ToolParam("applied", "boolean", "true to mark applied, false to clear (default true)"),
            ],
            handler=_set_applied,
            requires_confirmation=True,
            running_title="Updating applied status",
            label="Mark applied",
            category="Applications",
            example="Mark my top 3 matches as applied",
        )
    ),
    register_tool(
        ToolSpec(
            name="rerun_matches",
            description="Re-run AI match analysis for the given jobs (e.g. after a profile/résumé update).",
            params=[ToolParam("job_ids", "string[]", "job ids to re-analyse", required=True)],
            handler=_rerun_matches,
            requires_confirmation=True,
            running_title="Re-running analysis",
            label="Re-score matches",
            category="Applications",
            example="Re-score my ready jobs against my updated resume",
        )
    ),
    register_tool(
        ToolSpec(
            name="trigger_sync",
            description="Start a scraper sync to fetch new jobs from platforms. Omit platforms to sync all.",
            params=[ToolParam("platforms", "string[]", "platform names to sync, e.g. ['linkedin']; empty = all")],
            handler=_trigger_sync,
            requires_confirmation=True,
            running_title="Starting sync",
            label="Sync new jobs",
            category="Admin",
            example="Sync new jobs from all platforms",
            admin_only=True,
        )
    ),
]
