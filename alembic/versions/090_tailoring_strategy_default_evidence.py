"""New accounts default to evidence-based resume tailoring.

Only the column default changes; existing users keep whatever they chose.

Revision ID: 090_tailoring_default_evidence
Revises: 089_gmail_connections
Create Date: 2026-10-15
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "090_tailoring_default_evidence"
down_revision = "089_gmail_connections"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "users",
        "resume_tailoring_strategy",
        server_default="evidence",
        existing_type=sa.String(20),
        existing_nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        "users",
        "resume_tailoring_strategy",
        server_default="job_first",
        existing_type=sa.String(20),
        existing_nullable=False,
    )
