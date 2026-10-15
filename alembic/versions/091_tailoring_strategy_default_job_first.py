"""New accounts default to job-first resume tailoring.

Only the column default changes; existing users keep whatever they chose.

Revision ID: 091_tailoring_default_job_first
Revises: 090_tailoring_default_evidence
Create Date: 2026-10-15
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "091_tailoring_default_job_first"
down_revision = "090_tailoring_default_evidence"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "users",
        "resume_tailoring_strategy",
        server_default="job_first",
        existing_type=sa.String(20),
        existing_nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        "users",
        "resume_tailoring_strategy",
        server_default="evidence",
        existing_type=sa.String(20),
        existing_nullable=False,
    )
