"""Jobicy remote jobs API v2, no key."""

from __future__ import annotations

from typing import Any

from app.job_sites.base import AuthType, FetchContext, JobSitePlugin
from app.job_sites.http import get_json
from app.job_sites.registry import register
from app.services.job_source_boards import BoardJob


def parse_jobicy(payload: Any, *, max_jobs: int) -> list[BoardJob]:
    jobs: list[BoardJob] = []
    for item in (payload or {}).get("jobs") or []:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        title = str(item.get("jobTitle") or item.get("title") or "").strip()
        if not url or not title:
            continue
        jobs.append(
            BoardJob(
                url=url,
                title=title,
                location=str(item.get("jobGeo") or "Remote").strip(),
                company=str(item.get("companyName") or "").strip(),
            )
        )
        if len(jobs) >= max_jobs:
            break
    return jobs


async def _fetch(_credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    payload = await get_json(
        "https://jobicy.com/api/v2/remote-jobs",
        params={"count": min(50, ctx.max_jobs)},
    )
    return parse_jobicy(payload, max_jobs=ctx.max_jobs)


register(
    JobSitePlugin(
        slug="jobicy",
        name="Jobicy",
        blurb="Remote roles from Jobicy's public v2 API. Enable to start syncing.",
        homepage="https://jobicy.com/",
        auth_type=AuthType.NONE,
        logo_file="jobicy.svg",
        sort_order=120,
        fetch=_fetch,
    )
)
