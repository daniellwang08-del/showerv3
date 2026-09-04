"""Arbeitnow public job-board API — no key."""

from __future__ import annotations

from typing import Any

from app.job_sites.base import AuthType, FetchContext, JobSitePlugin
from app.job_sites.http import get_json
from app.job_sites.registry import register
from app.services.job_source_boards import BoardJob


def parse_arbeitnow(payload: Any, *, max_jobs: int) -> list[BoardJob]:
    jobs: list[BoardJob] = []
    for item in (payload or {}).get("data") or []:
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
                location=str(item.get("location") or "").strip(),
                company=str(item.get("company_name") or "").strip(),
            )
        )
        if len(jobs) >= max_jobs:
            break
    return jobs


async def _fetch(_credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    payload = await get_json("https://www.arbeitnow.com/api/job-board-api")
    return parse_arbeitnow(payload, max_jobs=ctx.max_jobs)


register(
    JobSitePlugin(
        slug="arbeitnow",
        name="Arbeitnow",
        blurb="EU and global tech jobs from Arbeitnow's public board API.",
        homepage="https://www.arbeitnow.com/",
        auth_type=AuthType.NONE,
        logo_file="arbeitnow.svg",
        sort_order=110,
        fetch=_fetch,
    )
)
