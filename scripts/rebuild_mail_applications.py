"""Re-apply the inbox application rules to stored confirmations.

Earlier rules stored one application twice (a recruiting platform and the
employer, a confirmation and an account email), linked one email to every job
whose title only differed in its team qualifier, and never linked an email
without a role to the job the user marked applied in NAO. For every user with
confirmations this:

* drops stored rows that repeat an earlier application,
* relinks every confirmation to at most one job (``link_jobs``), keeping links
  whose job the user unmarked, and
* deletes "Email confirmation" marks no confirmation is linked to any more.

Defaults to a dry run. Pass --apply to write.

Usage:
    python -m scripts.rebuild_mail_applications
    python -m scripts.rebuild_mail_applications --apply
"""

from __future__ import annotations

import argparse
import asyncio
from collections import Counter

from sqlalchemy import delete, select

from app.models.database import Job, MailApplication, ValidJobUserApplication
from app.services import mail_applications as ma
from app.storage.database import close_database, get_session, init_database


async def _rebuild_user(user_id: str, apply_changes: bool, stats: Counter[str], samples: list[str]) -> None:
    async with get_session() as session:
        rows = list(
            (
                await session.execute(
                    select(MailApplication)
                    .where(MailApplication.user_id == user_id)
                    .order_by(MailApplication.applied_at, MailApplication.created_at)
                )
            ).scalars()
        )
        stats["rows"] += len(rows)
        kept: list[MailApplication] = []
        for row in rows:
            original = ma.repeated_application(
                kept,
                company=row.company,
                key=row.company_key,
                role=row.role_title,
                applied_at=row.applied_at,
                subject=row.email_subject,
                sender=row.email_from,
            )
            if original is None:
                kept.append(row)
                continue
            stats["dropped_repeat"] += 1
            if len(samples) < 60:
                samples.append(
                    f"{row.applied_at:%m-%d %H:%M} {row.company} | {row.role_title or '-'} | {row.email_subject}"
                    f"  repeats  {original.company} | {original.role_title or '-'}"
                )
            await session.delete(row)

        marks = {
            job_id: by
            for job_id, by in (
                await session.execute(
                    select(ValidJobUserApplication.job_id, ValidJobUserApplication.applied_by_name).where(
                        ValidJobUserApplication.user_id == user_id
                    )
                )
            ).all()
        }
        for row in kept:
            linked = list(row.linked_job_ids or [])
            if linked and not any(j in marks for j in linked):
                stats["kept_unmarked_link"] += 1
                continue
            row.job_id = None
            row.linked_job_ids = []
        await session.flush()
        stats["newly_marked"] += await ma.link_jobs(session, user_id)
        stats["linked"] += sum(1 for r in kept if r.job_id)
        stats["kept"] += len(kept)

        claimed = select(MailApplication.job_id).where(
            MailApplication.user_id == user_id, MailApplication.job_id.is_not(None)
        )
        stale = [
            ValidJobUserApplication.user_id == user_id,
            ValidJobUserApplication.applied_by_name == ma.EMAIL_APPLIED_LABEL,
            ValidJobUserApplication.job_id.not_in(claimed),
        ]
        for company, title in (
            await session.execute(
                select(Job.company, Job.title).join(ValidJobUserApplication, ValidJobUserApplication.job_id == Job.id).where(*stale)
            )
        ).all():
            if len(samples) < 120:
                samples.append(f"unmark: {company} | {title}")
        removed = await session.execute(delete(ValidJobUserApplication).where(*stale))
        stats["removed_email_marks"] += removed.rowcount or 0
        if apply_changes:
            await session.commit()
        else:
            await session.rollback()


async def _run(apply_changes: bool) -> None:
    await init_database(pool_size=2, max_overflow=0)
    stats: Counter[str] = Counter()
    samples: list[str] = []
    try:
        async with get_session() as session:
            users = list((await session.execute(select(MailApplication.user_id).distinct())).scalars())
        for user_id in users:
            before = dict(stats)
            await _rebuild_user(user_id, apply_changes, stats, samples)
            print(user_id, {k: v - before.get(k, 0) for k, v in stats.items() if v - before.get(k, 0)})
    finally:
        await close_database()
    print("\n".join(samples))
    print(dict(stats))
    print("applied" if apply_changes else "dry run, pass --apply to write")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apply", action="store_true", help="write the changes")
    args = parser.parse_args()
    asyncio.run(_run(args.apply))


if __name__ == "__main__":
    main()
