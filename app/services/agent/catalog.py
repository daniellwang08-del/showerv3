"""Concrete agent tools.

Each tool is a thin adapter over an existing FastAPI route coroutine (or
service), invoked with a synthetic ``current_user`` dict built from the
server-injected :class:`ToolContext`. Reusing the route handlers guarantees the
agent's behaviour stays identical to the human-facing UI and inherits all of its
validation, permissions and side effects.
"""

from __future__ import annotations

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


def _cu(ctx: ToolContext) -> dict[str, str]:
    return {"user_id": ctx.user_id}


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

_VIEWS = {"all", "today", "mine", "suggested"}
_SORTS = {"created_at", "match_score", "posted_date", "title", "company", "updated_at"}
_VIEW_LABELS = {
    "all": "all jobs",
    "today": "today's new jobs",
    "mine": "jobs you posted",
    "suggested": "suggested jobs",
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
    if view not in {"all", "today", "mine", "suggested"}:
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
        f"{d.get('my_jobs', 0)} posted by you, "
        f"{d.get('today_scraped', 0)} added today, "
        f"{d.get('total_remote', 0)} remote, "
        f"{d.get('extracted_jobs', 0)} extracted, "
        f"{d.get('ready_jobs', 0)} ready to apply."
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


# ── Registration ───────────────────────────────────────────────────────────

AGENT_TOOLS: list[ToolSpec] = [
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
                ToolParam("view", "string", "view tab: all, today, mine, suggested"),
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
                ToolParam("view", "string", "one of: all, today, mine, suggested"),
                ToolParam("sort", "string", "created_at | match_score | posted_date | title | company"),
                ToolParam("order", "string", "asc | desc"),
                ToolParam("limit", "number", "max jobs to return (1-50, default 20)"),
            ],
            handler=_search_jobs,
            running_title="Searching jobs",
        )
    ),
    register_tool(
        ToolSpec(
            name="get_stats",
            description="Get aggregate dashboard statistics (totals, today, remote, extracted, ready, posted-by-me).",
            params=[],
            handler=_get_stats,
            running_title="Reading stats",
        )
    ),
    register_tool(
        ToolSpec(
            name="get_sync_status",
            description="Check whether a scraper sync is currently running and its progress.",
            params=[],
            handler=_get_sync_status,
            running_title="Checking sync status",
        )
    ),
    register_tool(
        ToolSpec(
            name="get_job_details",
            description="Get the full details of a single job by id (description, extraction, applied status).",
            params=[ToolParam("job_id", "string", "the job id", required=True)],
            handler=_get_job_details,
            running_title="Loading job",
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
        )
    ),
]
