"""Add is_job_posting column to job_extractions, drop confidence_score.

The LLM analysis now returns a boolean flag indicating whether the page
is actually a job posting.  The old confidence_score column (always 0.0
in the new architecture) is dropped.

Revision ID: 017_is_job_posting
Revises: 016_add_extracted_status
Create Date: 2026-04-03
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "017_is_job_posting"
down_revision: str | None = "016_add_extracted_status"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "job_extractions",
        sa.Column("is_job_posting", sa.Boolean(), nullable=True),
    )
    op.drop_column("job_extractions", "confidence_score")


def downgrade() -> None:
    op.add_column(
        "job_extractions",
        sa.Column("confidence_score", sa.Float(), nullable=True),
    )
    op.drop_column("job_extractions", "is_job_posting")
