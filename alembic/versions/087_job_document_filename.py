"""Per-job document file name, overriding the account naming rule for one job.

Revision ID: 087_job_document_filename
Revises: 086_resume_tailoring_strategy
Create Date: 2026-10-08
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "087_job_document_filename"
down_revision = "086_resume_tailoring_strategy"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {c["name"] for c in sa.inspect(bind).get_columns("resume_build_results")}
    if "filename_override" not in columns:
        op.add_column("resume_build_results", sa.Column("filename_override", sa.String(length=200), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    columns = {c["name"] for c in sa.inspect(bind).get_columns("resume_build_results")}
    if "filename_override" in columns:
        op.drop_column("resume_build_results", "filename_override")
