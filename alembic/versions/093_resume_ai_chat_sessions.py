"""Per-resume OneClick AI chat history for Resume Studio.

Revision ID: 093_resume_ai_chat_sessions
Revises: 092_work_mode_preferences
Create Date: 2026-10-16
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "093_resume_ai_chat_sessions"
down_revision = "092_work_mode_preferences"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "resume_ai_chat_sessions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "resume_id",
            sa.String(36),
            sa.ForeignKey("resume_documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("messages", sa.JSON(), nullable=False),
        sa.Column("last_job_description", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", "resume_id", name="uq_resume_ai_chat_user_resume"),
    )
    op.create_index(
        "ix_resume_ai_chat_sessions_user_updated",
        "resume_ai_chat_sessions",
        ["user_id", "updated_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_resume_ai_chat_sessions_user_updated", table_name="resume_ai_chat_sessions")
    op.drop_table("resume_ai_chat_sessions")
