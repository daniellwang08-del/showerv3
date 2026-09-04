"""Remotive public remote-jobs API — no key."""

from __future__ import annotations

from typing import Any

from app.job_sites.base import AuthType, FetchContext, JobSitePlugin
from app.job_sites.http import get_json
from app.job_sites.registry import register
from app.services.job_source_boards import BoardJob


def parse_remotive(payload: Any, *, max_jobs: int) -> list[BoardJob]:
    jobs: list[BoardJob] = []
    for item in (payload or {}).get("jobs") or []:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        title = str(item.get("title") or "").strip()
        if not url or not title:
            continue
        jobs.append(
            BoardJob(
                url=url,
                title=title,
                location=str(item.get("candidate_required_location") or "Remote").strip(),
                company=str(item.get("company_name") or "").strip(),
            )
        )
        if len(jobs) >= max_jobs:
            break
    return jobs


async def _fetch(_credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    payload = await get_json("https://remotive.com/api/remote-jobs", params={"limit": ctx.max_jobs})
    return parse_remotive(payload, max_jobs=ctx.max_jobs)


register(
    JobSitePlugin(
        slug="remotive",
        name="Remotive",
        blurb="Curated remote jobs from Remotive's public API. Enable to start syncing.",
        homepage="https://remotive.com/",
        auth_type=AuthType.NONE,
        logo_file="remotive.svg",
        sort_order=100,
        fetch=_fetch,
    )
)
