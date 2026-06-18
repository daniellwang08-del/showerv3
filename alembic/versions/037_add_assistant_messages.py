"""Add assistant_messages table for the job-specific assistant conversation.

Stores per-job chat turns (role/content) identified by (user_id, job_id) so the
browser extension can restore a conversation when a job is reopened.

Revision ID: 037_assistant_messages
Revises: 036_llm_provider
Create Date: 2026-06-17
"""

from alembic import op
import sqlalchemy as sa

revision = "037_assistant_messages"
down_revision = "036_llm_provider"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "assistant_messages" not in tables:
        op.create_table(
            "assistant_messages",
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
            sa.Column("role", sa.String(20), nullable=False),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("meta", sa.JSON(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(),
                server_default=sa.func.now(),
                nullable=False,
            ),
        )
        op.create_index(
            "ix_assistant_messages_user_job",
            "assistant_messages",
            ["user_id", "job_id", "created_at"],
        )
        op.create_index(
            "ix_assistant_messages_user_id", "assistant_messages", ["user_id"]
        )
        op.create_index(
            "ix_assistant_messages_job_id", "assistant_messages", ["job_id"]
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "assistant_messages" in tables:
        op.drop_index("ix_assistant_messages_job_id", table_name="assistant_messages")
        op.drop_index("ix_assistant_messages_user_id", table_name="assistant_messages")
        op.drop_index(
            "ix_assistant_messages_user_job", table_name="assistant_messages"
        )
        op.drop_table("assistant_messages")
