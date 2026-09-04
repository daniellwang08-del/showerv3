"""Per-user job-site connections: ATS board URLs synced into the user pipeline.

Revision ID: 065_user_job_site_connections
Revises: 064_system_log_events
Create Date: 2026-09-03
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "065_user_job_site_connections"
down_revision = "064_system_log_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "user_job_site_connections" not in tables:
        op.create_table(
            "user_job_site_connections",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column(
                "user_id",
                sa.String(length=36),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("plugin_slug", sa.String(length=40), nullable=False),
            sa.Column("credentials_encrypted", sa.Text(), nullable=True),
            sa.Column(
                "enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("true"),
            ),
            sa.Column("last_synced_at", sa.DateTime(), nullable=True),
            sa.Column("last_error", sa.Text(), nullable=True),
            sa.Column("last_listing_count", sa.Integer(), nullable=True),
            sa.Column("last_new_jobs", sa.Integer(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.UniqueConstraint(
                "user_id", "plugin_slug", name="uq_user_job_site_plugin"
            ),
        )
        op.create_index(
            "ix_user_job_site_connections_user_id",
            "user_job_site_connections",
            ["user_id"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "user_job_site_connections" in set(inspector.get_table_names()):
        op.drop_table("user_job_site_connections")
