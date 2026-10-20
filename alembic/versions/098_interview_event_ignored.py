"""Interview events the user chose to ignore drop out of "needs your action".

Revision ID: 098_interview_event_ignored
Revises: 097_report_shares_accounts
Create Date: 2026-10-20
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "098_interview_event_ignored"
down_revision = "097_report_shares_accounts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if "interview_events" not in set(sa.inspect(bind).get_table_names()):
        return
    columns = {c["name"] for c in sa.inspect(bind).get_columns("interview_events")}
    if "ignored_at" not in columns:
        op.add_column("interview_events", sa.Column("ignored_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    if "interview_events" not in set(sa.inspect(bind).get_table_names()):
        return
    columns = {c["name"] for c in sa.inspect(bind).get_columns("interview_events")}
    if "ignored_at" in columns:
        op.drop_column("interview_events", "ignored_at")
