"""Re-derive Jobs table location / work mode from each posting's own fields.

Jobs added from an aggregator feed (Jobright) were seeded with the feed's
location, and hydration kept whichever string scored as more specific, so a
feed guess could outrank the posting ("Durham, NC" over "Morrisville, NC,
US"). Workday's remoteType / additionalLocations and Oracle Recruiting Cloud
postings were not read at all, so their work mode stayed empty.

For every active job with stored posting text this recomputes the location and
work mode the posting declares and writes them when they differ. Workday and
Oracle HCM postings are re-fetched from the vendor API first (their stored
text predates the fix). Manually pasted descriptions are never re-fetched.
Only location and work_mode change, plus company where the stored one is a
hostname guess or an ATS site title ("Pearson Candidate Experience Site").

Defaults to a dry run. Pass --apply to write.

Usage:
    python -m scripts.backfill_posting_location_mode
    python -m scripts.backfill_posting_location_mode --apply
    python -m scripts.backfill_posting_location_mode --no-refetch --apply
"""

from __future__ import annotations

import argparse
import asyncio
import json
from collections import Counter

from sqlalchemy import select
from sqlalchemy.orm import undefer

from app.extractors.oracle_hcm_extractor import (
    OracleHcmExtractor,
    company_from_site_name,
    is_oracle_hcm_job_url,
)
from app.extractors.workday_extractor import WorkdayExtractor, is_workday_job_url
from app.models.database import Job, JobExtraction
from app.services.http_client import HTTPService, close_http_client, init_http_client
from app.services.job_field_utils import clean_optional_job_field, normalize_work_mode_display
from app.services.job_location_parse import strip_work_mode_from_location
from app.services.job_metadata_hydrator import (
    STRUCTURED_DATA_KEY,
    build_metadata,
    infer_company_from_url,
)
from app.storage.database import close_database, get_session, init_database

# Jobs handled concurrently; each holds one DB session while it works.
_BATCH = 8

def _vendor_extractor(url: str, http: HTTPService):
    if is_workday_job_url(url):
        return "workday", WorkdayExtractor(http)
    if is_oracle_hcm_job_url(url):
        return "oracle_hcm", OracleHcmExtractor(http)
    return None, None


async def _refetch(url: str, http: HTTPService, sem: asyncio.Semaphore):
    vendor, extractor = _vendor_extractor(url, http)
    if extractor is None:
        return None, None
    async with sem:
        try:
            result = await extractor.extract(url)
        except Exception as e:  # noqa: BLE001
            print(f"  refetch error {vendor} {url}: {e}")
            return vendor, None
    return vendor, result if result.success and result.raw_content else None


async def _run(apply_changes: bool, refetch: bool, concurrency: int, max_samples: int) -> None:
    await init_database()
    await init_http_client()
    http = HTTPService()
    sem = asyncio.Semaphore(concurrency)
    stats: Counter[str] = Counter()
    samples: list[str] = []
    try:
        async with get_session() as session:
            rows = (
                await session.execute(
                    select(Job.id, Job.source_url, Job.extraction_id)
                    .where(Job.status == "active", Job.extraction_id.is_not(None))
                )
            ).all()
        print(f"active jobs with an extraction: {len(rows)}")

        async def handle(job_id: str, url: str, extraction_id: str) -> None:
            vendor, fresh = (None, None)
            if refetch and url:
                vendor, fresh = await _refetch(url, http, sem)
            async with get_session() as session:
                job = (
                    await session.execute(select(Job).where(Job.id == job_id))
                ).scalar_one_or_none()
                extraction = (
                    await session.execute(
                        select(JobExtraction)
                        .options(undefer(JobExtraction.raw_plain_text))
                        .where(JobExtraction.id == extraction_id)
                    )
                ).scalar_one_or_none()
                if job is None or extraction is None:
                    return
                metadata = dict(extraction.raw_metadata or {})
                manual = bool(metadata.get("manual_jd"))
                text = extraction.raw_plain_text
                structured = metadata.get(STRUCTURED_DATA_KEY)
                if fresh is not None and not manual:
                    stats[f"refetched_{vendor}"] += 1
                    text = fresh.raw_content
                    structured = json.loads(json.dumps(fresh.structured_data, default=str)) if fresh.structured_data else None
                elif vendor:
                    stats[f"refetch_failed_{vendor}"] += 1
                if not text:
                    stats["no_text"] += 1
                    return

                meta = build_metadata(
                    plain_text=text,
                    source_url=url,
                    structured_data=structured if isinstance(structured, dict) else None,
                    existing_location=job.location,
                    existing_work_mode=job.work_mode,
                )
                changes: dict[str, tuple[str | None, str | None]] = {}
                new_location = strip_work_mode_from_location(meta["location"]) if meta["location_from_page"] else None
                if new_location and new_location[:500] != (job.location or ""):
                    changes["location"] = (job.location, new_location[:500])
                new_mode = normalize_work_mode_display(meta["work_mode"])
                if new_mode and new_mode != job.work_mode and (
                    meta["work_mode_from_page"] or not clean_optional_job_field(job.work_mode)
                ):
                    changes["work_mode"] = (job.work_mode, new_mode)
                hint = clean_optional_job_field((structured or {}).get("company_hint"))
                stored = clean_optional_job_field(job.company)
                weak_company = (
                    not stored
                    or stored == infer_company_from_url(url)
                    or company_from_site_name(stored) != stored
                )
                if hint and weak_company and hint != stored:
                    changes["company"] = (job.company, hint[:500])

                if not changes and fresh is None:
                    return
                for field in changes:
                    stats[f"changed_{field}"] += 1
                if changes and len(samples) < max_samples:
                    samples.append(f"{job_id} {url[:90]} " + "; ".join(f"{k}: {a!r} -> {b!r}" for k, (a, b) in changes.items()))
                if not apply_changes:
                    return
                for field, (_old, new) in changes.items():
                    setattr(job, field, new)
                    setattr(extraction, field, new)
                if fresh is not None and not manual:
                    extraction.raw_plain_text = text
                    if structured:
                        metadata[STRUCTURED_DATA_KEY] = structured
                    extraction.raw_metadata = metadata

        for start in range(0, len(rows), _BATCH):
            await asyncio.gather(*(handle(*row) for row in rows[start : start + _BATCH]))
    finally:
        await close_http_client()
        await close_database()

    print("\n".join(samples))
    print(dict(stats))
    print("applied" if apply_changes else "dry run, pass --apply to write")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apply", action="store_true", help="write the changes")
    parser.add_argument("--no-refetch", action="store_true", help="skip Workday / Oracle HCM API calls")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--samples", type=int, default=40, help="changed jobs to print")
    args = parser.parse_args()
    asyncio.run(_run(args.apply, not args.no_refetch, args.concurrency, args.samples))


if __name__ == "__main__":
    main()
