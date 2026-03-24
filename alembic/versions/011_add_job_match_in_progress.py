"""Add job_match_in_progress table for real-time AI processing status

Revision ID: 011_job_match_progress
Revises: 010_job_match
Create Date: 2026-02-27

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "011_job_match_progress"
down_revision: Union[str, None] = "010_job_match"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "job_match_in_progress",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("valid_job_id", sa.String(36), sa.ForeignKey("valid_jobs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("valid_job_id", "user_id", name="uq_job_match_progress_valid_job_user"),
    )
    op.create_index(
        "ix_job_match_in_progress_valid_user",
        "job_match_in_progress",
        ["valid_job_id", "user_id"],
    )


def downgrade() -> None:
    op.drop_table("job_match_in_progress")
