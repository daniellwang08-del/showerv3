"""Add promotion tracking columns to scraped_jobs.

These columns let us bridge the scraper into the extraction lifecycle:
when a scraped row is promoted (i.e. a JobExtraction + ValidJob is created
for it and the description-extraction worker is enqueued), the row is
stamped with the resulting extraction id and timestamp.  This makes the
bridge idempotent and survives worker retries.

Revision ID: 022_add_scraped_job_promotion
Revises: 021_add_scraper_tables
Create Date: 2026-05-19
"""

from alembic import op
import sqlalchemy as sa

revision = "022_add_scraped_job_promotion"
down_revision = "021_add_scraper_tables"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "scraped_jobs",
        sa.Column("promoted_extraction_id", sa.String(36), nullable=True),
    )
    op.add_column(
        "scraped_jobs",
        sa.Column("promoted_at", sa.DateTime(), nullable=True),
    )
    op.create_index(
        "ix_scraped_jobs_promoted_extraction_id",
        "scraped_jobs",
        ["promoted_extraction_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_scraped_jobs_promoted_extraction_id", table_name="scraped_jobs")
    op.drop_column("scraped_jobs", "promoted_at")
    op.drop_column("scraped_jobs", "promoted_extraction_id")
