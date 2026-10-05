"""Connection lifecycle for user job sites: status, backoff schedule, usage.

status separates "sign in again" (needs_reauth) from "wait" (rate_limited,
quota_exhausted) and from config or repeated transient failures (error), so
the scheduler stops polling dead sessions and the UI can ask for a reconnect.

Revision ID: 074_job_site_lifecycle
Revises: 073_match_engine_v5_requirements
Create Date: 2026-10-05
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "074_job_site_lifecycle"
down_revision = "073_match_engine_v5_requirements"
branch_labels = None
depends_on = None

TABLE = "user_job_site_connections"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("status", sa.String(20), nullable=False, server_default="connected"))
    op.add_column(TABLE, sa.Column("consecutive_failures", sa.Integer(), nullable=False, server_default="0"))
    op.add_column(TABLE, sa.Column("next_sync_at", sa.DateTime(), nullable=True))
    op.add_column(TABLE, sa.Column("last_success_at", sa.DateTime(), nullable=True))
    op.add_column(TABLE, sa.Column("request_count", sa.Integer(), nullable=False, server_default="0"))
    op.execute(
        f"UPDATE {TABLE} SET last_success_at = last_synced_at "
        "WHERE last_error IS NULL AND last_synced_at IS NOT NULL"
    )


def downgrade() -> None:
    for column in ("request_count", "last_success_at", "next_sync_at", "consecutive_failures", "status"):
        op.drop_column(TABLE, column)
