"""System log events for the admin logs dashboard.

Revision ID: 064_system_log_events
Revises: 063_user_job_sources
Create Date: 2026-09-03
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "064_system_log_events"
down_revision = "063_user_job_sources"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "system_log_events" not in tables:
        op.create_table(
            "system_log_events",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("level", sa.String(length=20), nullable=False),
            sa.Column("event", sa.String(length=200), nullable=False),
            sa.Column("logger_name", sa.String(length=200), nullable=True),
            sa.Column("category", sa.String(length=40), nullable=False, server_default="process"),
            sa.Column("service", sa.String(length=40), nullable=False, server_default="api"),
            sa.Column("request_id", sa.String(length=64), nullable=True),
            sa.Column("user_id", sa.String(length=36), nullable=True),
            sa.Column("job_id", sa.String(length=36), nullable=True),
            sa.Column("extraction_id", sa.String(length=36), nullable=True),
            sa.Column("worker_job_type", sa.String(length=80), nullable=True),
            sa.Column("method", sa.String(length=16), nullable=True),
            sa.Column("path", sa.String(length=500), nullable=True),
            sa.Column("status_code", sa.Integer(), nullable=True),
            sa.Column("duration_ms", sa.Float(), nullable=True),
            sa.Column("client_ip", sa.String(length=64), nullable=True),
            sa.Column("message", sa.Text(), nullable=True),
            sa.Column("payload", sa.JSON(), nullable=True),
        )
        op.create_index("ix_system_log_events_created_at", "system_log_events", ["created_at"])
        op.create_index("ix_system_log_events_request_id", "system_log_events", ["request_id"])
        op.create_index("ix_system_log_events_level", "system_log_events", ["level"])
        op.create_index("ix_system_log_events_category", "system_log_events", ["category"])
        op.create_index("ix_system_log_events_path", "system_log_events", ["path"])
        op.create_index(
            "ix_system_log_events_level_created",
            "system_log_events",
            ["level", "created_at"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "system_log_events" in set(inspector.get_table_names()):
        op.drop_table("system_log_events")
