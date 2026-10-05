"""Saved assistant chats: one row per conversation, kept until the user deletes it.

Revision ID: 075_agent_chat_sessions
Revises: 074_job_site_lifecycle
Create Date: 2026-10-05
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "075_agent_chat_sessions"
down_revision = "074_job_site_lifecycle"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_chat_sessions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(200), nullable=False, server_default="New chat"),
        sa.Column("items", sa.JSON(), nullable=False),
        sa.Column("item_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_agent_chat_sessions_user_updated", "agent_chat_sessions", ["user_id", "updated_at"])


def downgrade() -> None:
    op.drop_index("ix_agent_chat_sessions_user_updated", table_name="agent_chat_sessions")
    op.drop_table("agent_chat_sessions")
