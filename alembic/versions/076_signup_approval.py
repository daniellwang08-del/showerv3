"""Approval-gated signup: user approval state, session cutoff, admin access keys.

Revision ID: 076_signup_approval
Revises: 075_agent_chat_sessions
Create Date: 2026-10-05
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "076_signup_approval"
down_revision = "075_agent_chat_sessions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("approval_status", sa.String(16), nullable=False, server_default="approved"),
    )
    op.add_column("users", sa.Column("approved_at", sa.DateTime(), nullable=True))
    op.add_column("users", sa.Column("approved_by", sa.String(36), nullable=True))
    op.add_column("users", sa.Column("sessions_valid_after", sa.DateTime(), nullable=True))
    op.create_index("ix_users_approval_status", "users", ["approval_status"])

    op.create_table(
        "signup_access_keys",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("key_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("used_at", sa.DateTime(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_signup_access_keys_user_id", "signup_access_keys", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_signup_access_keys_user_id", table_name="signup_access_keys")
    op.drop_table("signup_access_keys")
    op.drop_index("ix_users_approval_status", table_name="users")
    op.drop_column("users", "sessions_valid_after")
    op.drop_column("users", "approved_by")
    op.drop_column("users", "approved_at")
    op.drop_column("users", "approval_status")
