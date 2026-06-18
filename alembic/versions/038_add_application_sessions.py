"""Add application_sessions table for in-progress job applications.

Persists a snapshot of the structured job description for a job the user is
applying to through the assistant extension, so it survives across devices and
remains stable until the user completes or removes the session.

Revision ID: 038_application_sessions
Revises: 037_assistant_messages
Create Date: 2026-06-17
"""

from alembic import op
import sqlalchemy as sa

revision = "038_application_sessions"
down_revision = "037_assistant_messages"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "application_sessions" not in tables:
        op.create_table(
            "application_sessions",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column(
                "user_id",
                sa.String(36),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "job_id",
                sa.String(36),
                sa.ForeignKey("jobs.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "status",
                sa.String(20),
                nullable=False,
                server_default="in_progress",
            ),
            sa.Column("job_snapshot", sa.JSON(), nullable=True),
            sa.Column("job_url", sa.Text(), nullable=True),
            sa.Column("job_title", sa.String(500), nullable=True),
            sa.Column("company", sa.String(500), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.UniqueConstraint(
                "user_id", "job_id", name="uq_application_session_user_job"
            ),
        )
        op.create_index(
            "ix_application_sessions_user_status",
            "application_sessions",
            ["user_id", "status"],
        )
        op.create_index(
            "ix_application_sessions_user_id", "application_sessions", ["user_id"]
        )
        op.create_index(
            "ix_application_sessions_job_id", "application_sessions", ["job_id"]
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "application_sessions" in tables:
        op.drop_index(
            "ix_application_sessions_job_id", table_name="application_sessions"
        )
        op.drop_index(
            "ix_application_sessions_user_id", table_name="application_sessions"
        )
        op.drop_index(
            "ix_application_sessions_user_status", table_name="application_sessions"
        )
        op.drop_table("application_sessions")
