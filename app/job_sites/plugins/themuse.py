"""The Muse public jobs API, key optional."""

from __future__ import annotations

from typing import Any

from app.job_sites.base import AuthType, FetchContext, JobSitePlugin
from app.job_sites.http import get_json
from app.job_sites.registry import register
from app.services.job_source_boards import BoardJob


def parse_themuse(payload: Any, *, max_jobs: int) -> list[BoardJob]:
    jobs: list[BoardJob] = []
    for item in (payload or {}).get("results") or []:
        if not isinstance(item, dict):
            continue
        refs = item.get("refs") if isinstance(item.get("refs"), dict) else {}
        url = str((refs or {}).get("landing_page") or item.get("landing_page") or "").strip()
        title = str(item.get("name") or "").strip()
        if not url or not title:
            continue
        company = ""
        co = item.get("company")
        if isinstance(co, dict):
            company = str(co.get("name") or "")
        locations = item.get("locations") or []
        location = ""
        if isinstance(locations, list) and locations:
            first = locations[0]
            location = first.get("name") if isinstance(first, dict) else str(first)
        jobs.append(
            BoardJob(
                url=url,
                title=title,
                location=str(location or "").strip(),
                company=company.strip(),
            )
        )
        if len(jobs) >= max_jobs:
            break
    return jobs


async def _fetch(_credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    payload = await get_json(
        "https://www.themuse.com/api/public/jobs",
        params={"page": 0, "descending": "true"},
    )
    return parse_themuse(payload, max_jobs=ctx.max_jobs)


register(
    JobSitePlugin(
        slug="themuse",
        name="The Muse",
        blurb="Curated employer jobs from The Muse public API. Enable to start syncing.",
        homepage="https://www.themuse.com/",
        auth_type=AuthType.NONE,
        logo_file="themuse.svg",
        sort_order=130,
        fetch=_fetch,
    )
)
