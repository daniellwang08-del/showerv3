"""RemoteOK public JSON feed, no key."""

from __future__ import annotations

from typing import Any

from app.job_sites.base import AuthType, FetchContext, JobSitePlugin
from app.job_sites.http import get_json
from app.job_sites.registry import register
from app.services.job_source_boards import BoardJob


def parse_remoteok(payload: Any, *, max_jobs: int) -> list[BoardJob]:
    jobs: list[BoardJob] = []
    if not isinstance(payload, list):
        return jobs
    for item in payload:
        if not isinstance(item, dict):
            continue
        if item.get("legal") or not item.get("id"):
            continue
        url = str(item.get("url") or item.get("apply_url") or "").strip()
        title = str(item.get("position") or item.get("title") or "").strip()
        if not url or not title:
            continue
        jobs.append(
            BoardJob(
                url=url,
                title=title,
                location=str(item.get("location") or "Remote").strip(),
                company=str(item.get("company") or "").strip(),
            )
        )
        if len(jobs) >= max_jobs:
            break
    return jobs


async def _fetch(_credentials: dict[str, Any], ctx: FetchContext) -> list[BoardJob]:
    payload = await get_json("https://remoteok.com/api")
    return parse_remoteok(payload, max_jobs=ctx.max_jobs)


register(
    JobSitePlugin(
        slug="remoteok",
        name="Remote OK",
        blurb="Public remote tech jobs. Enable the tile, no account required.",
        homepage="https://remoteok.com/",
        auth_type=AuthType.NONE,
        logo_file="remoteok.svg",
        sort_order=90,
        fetch=_fetch,
    )
)
