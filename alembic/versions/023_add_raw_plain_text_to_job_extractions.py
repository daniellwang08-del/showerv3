"""Add raw_plain_text column to job_extractions.

Stores the original extracted plain text from the page before any LLM
structuring.  This allows any user to re-run AI analysis without
re-fetching the job posting, because the original text survives after
the first user's analysis (which overwrites `description` with structured
content).

Revision ID: 023_add_raw_plain_text_to_job_extractions
Revises: 022_add_scraped_job_promotion
Create Date: 2026-05-20
"""

from alembic import op
import sqlalchemy as sa

revision = "023_raw_plain_text"
down_revision = "022_add_scraped_job_promotion"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "job_extractions",
        sa.Column("raw_plain_text", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("job_extractions", "raw_plain_text")
