"""Job-site sync activity: running phase and the jobs the last sync added.

Revision ID: 088_job_site_sync_activity
Revises: 087_job_document_filename
Create Date: 2026-10-09
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "088_job_site_sync_activity"
down_revision = "087_job_document_filename"
branch_labels = None
depends_on = None

TABLE = "user_job_site_connections"
NEW_COLUMNS = (
    sa.Column("sync_phase", sa.String(length=20), nullable=True),
    sa.Column("sync_started_at", sa.DateTime(), nullable=True),
    sa.Column("last_sync_jobs", sa.JSON(), nullable=True),
)


def upgrade() -> None:
    columns = {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}
    for column in NEW_COLUMNS:
        if column.name not in columns:
            op.add_column(TABLE, column)


def downgrade() -> None:
    columns = {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}
    for column in reversed(NEW_COLUMNS):
        if column.name in columns:
            op.drop_column(TABLE, column.name)
