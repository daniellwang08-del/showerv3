"""Drop work-mode words (Remote, Hybrid, On-site) from stored job locations.

The Mode column already shows them. A dropped word fills ``work_mode`` only
where it was empty.

Revision ID: 081_location_without_work_mode
Revises: 080_match_quality_check
Create Date: 2026-10-06
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

from app.services.job_location_parse import split_work_mode_from_location

revision = "081_location_without_work_mode"
down_revision = "080_match_quality_check"
branch_labels = None
depends_on = None

_MODE_SQL = (
    r"location ~* '(remote|hybrid|on[ -]?site|in[ -]?office|in[ -]?person|office[ -]+based"
    r"|work(ing)?[ -]+from[ -]+(home|anywhere)|wfh|telecommut)'"
)


def _clean_table(conn, table: str) -> int:
    rows = conn.execute(
        sa.text(f"SELECT id, location, work_mode FROM {table} WHERE location IS NOT NULL AND {_MODE_SQL}")
    ).fetchall()
    changed = 0
    for row_id, location, work_mode in rows:
        cleaned, mode = split_work_mode_from_location(location)
        if cleaned == location:
            continue
        conn.execute(
            sa.text(f"UPDATE {table} SET location = :location, work_mode = :work_mode WHERE id = :id"),
            {"location": cleaned[:500] if cleaned else None, "work_mode": work_mode or mode, "id": row_id},
        )
        changed += 1
    return changed


def upgrade() -> None:
    conn = op.get_bind()
    ext = _clean_table(conn, "job_extractions")
    jobs = _clean_table(conn, "jobs")
    print(f"Removed work-mode words from locations: job_extractions={ext}, jobs={jobs}")


def downgrade() -> None:
    # Data cleanup is not reversible.
    pass
