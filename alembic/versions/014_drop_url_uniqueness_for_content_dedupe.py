"""Drop URL uniqueness constraints for content-based dedupe.

Revision ID: 014_drop_url_uniqueness
Revises: 013_valid_job_user_applications
Create Date: 2026-03-31
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "014_drop_url_uniqueness"
down_revision: Union[str, None] = "013_valid_job_user_applications"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Remove URL-based uniqueness so submissions are never deduped by URL at intake.
    op.drop_constraint("job_extractions_normalized_url_key", "job_extractions", type_="unique")
    op.drop_constraint("valid_jobs_source_url_key", "valid_jobs", type_="unique")
    op.drop_constraint("valid_jobs_normalized_url_key", "valid_jobs", type_="unique")
    op.drop_constraint("invalid_jobs_source_url_key", "invalid_jobs", type_="unique")
    op.drop_constraint("invalid_jobs_normalized_url_key", "invalid_jobs", type_="unique")

    # Keep lookup performance for URL-oriented diagnostics and tools.
    op.create_index("ix_job_extractions_normalized_url", "job_extractions", ["normalized_url"], unique=False)
    op.create_index("ix_valid_jobs_normalized_url", "valid_jobs", ["normalized_url"], unique=False)
    op.create_index("ix_invalid_jobs_normalized_url", "invalid_jobs", ["normalized_url"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_invalid_jobs_normalized_url", table_name="invalid_jobs")
    op.drop_index("ix_valid_jobs_normalized_url", table_name="valid_jobs")
    op.drop_index("ix_job_extractions_normalized_url", table_name="job_extractions")

    op.create_unique_constraint("invalid_jobs_normalized_url_key", "invalid_jobs", ["normalized_url"])
    op.create_unique_constraint("invalid_jobs_source_url_key", "invalid_jobs", ["source_url"])
    op.create_unique_constraint("valid_jobs_normalized_url_key", "valid_jobs", ["normalized_url"])
    op.create_unique_constraint("valid_jobs_source_url_key", "valid_jobs", ["source_url"])
    op.create_unique_constraint("job_extractions_normalized_url_key", "job_extractions", ["normalized_url"])
