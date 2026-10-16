"""Nylas mail connections and interview pipeline tables.

Revision ID: 094_mail_interviews
Revises: 093_resume_ai_chat_sessions
Create Date: 2026-10-16
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "094_mail_interviews"
down_revision = "093_resume_ai_chat_sessions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())

    if "mail_connections" not in tables:
        op.create_table(
            "mail_connections",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True),
            sa.Column("grant_id", sa.String(255), nullable=False),
            sa.Column("email", sa.String(255), nullable=False),
            sa.Column("provider", sa.String(50), nullable=True),
            sa.Column("status", sa.String(32), nullable=False, server_default="connected"),
            sa.Column("last_error", sa.Text(), nullable=True),
            sa.Column("sync_status", sa.String(16), nullable=False, server_default="idle"),
            sa.Column("sync_started_at", sa.DateTime(), nullable=True),
            sa.Column("last_synced_at", sa.DateTime(), nullable=True),
            sa.Column("last_sync_error", sa.Text(), nullable=True),
            sa.Column("sync_cursor", sa.DateTime(), nullable=True),
            sa.Column("last_sync_stats", sa.JSON(), nullable=True),
            sa.Column("connected_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        )
        op.create_index("ix_mail_connections_user_id", "mail_connections", ["user_id"])

    if "interview_processes" not in tables:
        op.create_table(
            "interview_processes",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("company", sa.String(300), nullable=False),
            sa.Column("company_key", sa.String(300), nullable=False),
            sa.Column("role_title", sa.String(300), nullable=True),
            sa.Column("job_id", sa.String(36), sa.ForeignKey("jobs.id", ondelete="SET NULL"), nullable=True),
            sa.Column("stage", sa.String(20), nullable=False, server_default="screening"),
            sa.Column("status", sa.String(16), nullable=False, server_default="active"),
            sa.Column("next_step", sa.Text(), nullable=True),
            sa.Column("remaining_steps", sa.JSON(), nullable=True),
            sa.Column("notes", sa.Text(), nullable=True),
            sa.Column("source", sa.String(16), nullable=False, server_default="email"),
            sa.Column("last_activity_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        )
        op.create_index("ix_interview_processes_user_id", "interview_processes", ["user_id"])
        op.create_index("ix_interview_processes_user_company", "interview_processes", ["user_id", "company_key"])

    if "interview_events" not in tables:
        op.create_table(
            "interview_events",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column(
                "process_id",
                sa.String(36),
                sa.ForeignKey("interview_processes.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("kind", sa.String(32), nullable=False),
            sa.Column("status", sa.String(24), nullable=False, server_default="info"),
            sa.Column("title", sa.String(300), nullable=True),
            sa.Column("scheduled_at", sa.DateTime(), nullable=True),
            sa.Column("duration_minutes", sa.Integer(), nullable=True),
            sa.Column("meeting_url", sa.Text(), nullable=True),
            sa.Column("location", sa.String(500), nullable=True),
            sa.Column("interviewers", sa.String(500), nullable=True),
            sa.Column("summary", sa.Text(), nullable=True),
            sa.Column("message_id", sa.String(255), nullable=True),
            sa.Column("thread_id", sa.String(255), nullable=True),
            sa.Column("email_subject", sa.String(500), nullable=True),
            sa.Column("email_from", sa.String(500), nullable=True),
            sa.Column("email_date", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
            sa.UniqueConstraint("user_id", "message_id", name="uq_interview_event_user_message"),
        )
        op.create_index("ix_interview_events_process_id", "interview_events", ["process_id"])
        op.create_index("ix_interview_events_user_id", "interview_events", ["user_id"])


def downgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    if "interview_events" in tables:
        op.drop_table("interview_events")
    if "interview_processes" in tables:
        op.drop_table("interview_processes")
    if "mail_connections" in tables:
        op.drop_table("mail_connections")
