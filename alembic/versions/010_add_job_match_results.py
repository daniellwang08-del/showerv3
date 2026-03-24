"""Add job_match_results table for AI match analysis cache

Revision ID: 010_job_match
Revises: 009_openai_cache
Create Date: 2026-02-27

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "010_job_match"
down_revision: Union[str, None] = "009_openai_cache"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "job_match_results",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("valid_job_id", sa.String(36), sa.ForeignKey("valid_jobs.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("overall_score", sa.Integer(), nullable=False),
        sa.Column("dimension_scores", sa.JSON(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("strengths", sa.JSON(), nullable=False),
        sa.Column("gaps", sa.JSON(), nullable=False),
        sa.Column("recommendation", sa.String(50), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("valid_job_id", "user_id", name="uq_job_match_valid_job_user"),
    )
    op.create_index(
        "ix_job_match_valid_job_user",
        "job_match_results",
        ["valid_job_id", "user_id"],
    )


def downgrade() -> None:
    op.drop_table("job_match_results")
