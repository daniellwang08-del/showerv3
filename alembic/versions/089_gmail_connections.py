"""Per-user Gmail OAuth connection (read-only inbox search).

Revision ID: 089_gmail_connections
Revises: 088_job_site_sync_activity
Create Date: 2026-10-13
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "089_gmail_connections"
down_revision = "088_job_site_sync_activity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    if "gmail_connections" in tables:
        return
    op.create_table(
        "gmail_connections",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("google_email", sa.String(255), nullable=False),
        sa.Column("refresh_token_encrypted", sa.Text(), nullable=False),
        sa.Column("access_token_encrypted", sa.Text(), nullable=True),
        sa.Column("access_token_expires_at", sa.DateTime(), nullable=True),
        sa.Column("scopes", sa.Text(), nullable=False),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("status", sa.String(32), nullable=False, server_default="connected"),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("connected_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_gmail_connections_user_id", "gmail_connections", ["user_id"])


def downgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    if "gmail_connections" not in tables:
        return
    op.drop_index("ix_gmail_connections_user_id", table_name="gmail_connections")
    op.drop_table("gmail_connections")
