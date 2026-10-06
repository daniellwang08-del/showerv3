"""Put every owned job with no add session into one for its owner.

Jobs added before add sessions existed, or whose session request never landed
(assistant, extension, company sources, connected sites), had no batch and so
showed to everyone. Each owner gets one session per source, scoped by their
share default ("ask" starts private), so the jobs show in their add history.

Revision ID: 084_backfill_job_add_batches
Revises: 083_resume_doc_job_description
Create Date: 2026-10-06
"""

from __future__ import annotations

import uuid
from collections import defaultdict

import sqlalchemy as sa
from alembic import op


revision = "084_backfill_job_add_batches"
down_revision = "083_resume_doc_job_description"
branch_labels = None
depends_on = None

_ORPHANS = sa.text(
    """
    select j.id as job_id, j.created_at, o.owner_id, o.source, u.job_share_default
    from jobs j
    cross join lateral (
        select
            coalesce(
                case when coalesce(j.raw_metadata::jsonb->>'submitted_by_admin', '') <> 'true'
                     then nullif(j.raw_metadata::jsonb->>'submitted_by_user_id', '') end,
                nullif(j.raw_metadata::jsonb#>>'{user_job_source,user_id}', ''),
                nullif(j.raw_metadata::jsonb#>>'{user_job_site,user_id}', '')
            ) as owner_id,
            case when j.raw_metadata::jsonb ? 'submitted_data' then 'manual' else 'site' end as source
    ) o
    join users u on u.id = o.owner_id
    where j.status = 'active'
      and not exists (select 1 from job_add_batch_jobs b where b.job_id = j.id)
    """
)


def _scope(pref: str | None) -> str:
    value = (pref or "").strip().lower()
    return value if value in {"private", "team", "all"} else "private"


def upgrade() -> None:
    bind = op.get_bind()
    groups: dict[tuple[str, str, str], list[str]] = defaultdict(list)
    latest: dict[tuple[str, str, str], object] = {}
    for row in bind.execute(_ORPHANS).mappings():
        key = (row["owner_id"], row["source"], _scope(row["job_share_default"]))
        groups[key].append(row["job_id"])
        if row["created_at"] is not None and (key not in latest or row["created_at"] > latest[key]):
            latest[key] = row["created_at"]

    for key, job_ids in groups.items():
        owner_id, source, scope = key
        batch_id = str(uuid.uuid4())
        bind.execute(
            sa.text(
                "insert into job_add_batches (id, user_id, source, job_count, share_scope, created_at, updated_at) "
                "values (:id, :user_id, :source, :n, :scope, coalesce(cast(:at as timestamp), now()), now())"
            ),
            {
                "id": batch_id,
                "user_id": owner_id,
                "source": source,
                "n": len(job_ids),
                "scope": scope,
                "at": latest.get(key),
            },
        )
        bind.execute(
            sa.text("insert into job_add_batch_jobs (batch_id, job_id) values (:batch_id, :job_id)"),
            [{"batch_id": batch_id, "job_id": job_id} for job_id in job_ids],
        )


def downgrade() -> None:
    pass
