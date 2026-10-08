"""Per-user tailoring strategy: job-first rewrite (default) or evidence-based.

Revision ID: 086_resume_tailoring_strategy
Revises: 085_user_original_resumes
Create Date: 2026-10-08
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "086_resume_tailoring_strategy"
down_revision = "085_user_original_resumes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {c["name"] for c in sa.inspect(bind).get_columns("users")}
    if "resume_tailoring_strategy" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "resume_tailoring_strategy",
                sa.String(length=20),
                nullable=False,
                server_default="job_first",
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    columns = {c["name"] for c in sa.inspect(bind).get_columns("users")}
    if "resume_tailoring_strategy" in columns:
        op.drop_column("users", "resume_tailoring_strategy")
