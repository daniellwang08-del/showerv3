"""Merge interview bookings stored once per email.

An invite and every reply confirming the same time used to become separate
"scheduled" events. Keep one per process and time (the one with a meeting
link, else the earliest), copy missing details onto it, and turn the others
into timeline-only "info" events.

Revision ID: 106_merge_duplicate_bookings
Revises: 105_issue_reports
Create Date: 2026-10-21
"""

from __future__ import annotations

from datetime import timedelta

from alembic import op
import sqlalchemy as sa


revision = "106_merge_duplicate_bookings"
down_revision = "105_issue_reports"
branch_labels = None
depends_on = None

SAME_BOOKING = timedelta(minutes=5)
DETAILS = ("meeting_url", "location", "interviewers", "duration_minutes")


def _keeper(group: list[dict]) -> dict:
    return sorted(
        group,
        key=lambda r: (
            r["meeting_url"] is None,
            r["message_id"] is not None,
            r["email_date"] is None,
            r["email_date"] or r["created_at"],
        ),
    )[0]


def upgrade() -> None:
    bind = op.get_bind()
    rows = [
        dict(r._mapping)
        for r in bind.execute(
            sa.text(
                "select id, process_id, scheduled_at, message_id, email_date, created_at, "
                "meeting_url, location, interviewers, duration_minutes "
                "from interview_events where status = 'scheduled' and scheduled_at is not null "
                "order by process_id, scheduled_at"
            )
        )
    ]
    groups: list[list[dict]] = []
    for r in rows:
        last = groups[-1] if groups else None
        if last and last[0]["process_id"] == r["process_id"] and r["scheduled_at"] - last[0]["scheduled_at"] <= SAME_BOOKING:
            last.append(r)
        else:
            groups.append([r])

    for group in groups:
        if len(group) < 2:
            continue
        keep = _keeper(group)
        fill = {f: next((r[f] for r in group if r[f] is not None), None) for f in DETAILS if keep[f] is None}
        fill = {k: v for k, v in fill.items() if v is not None}
        if fill:
            sets = ", ".join(f"{k} = :{k}" for k in fill)
            bind.execute(sa.text(f"update interview_events set {sets} where id = :id"), {**fill, "id": keep["id"]})
        others = [r["id"] for r in group if r["id"] != keep["id"]]
        bind.execute(
            sa.text("update interview_events set status = 'info' where id in :ids").bindparams(
                sa.bindparam("ids", expanding=True)
            ),
            {"ids": others},
        )


def downgrade() -> None:
    pass
