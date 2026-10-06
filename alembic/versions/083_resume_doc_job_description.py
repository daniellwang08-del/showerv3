"""Keep the job description with each tailored resume.

Resumes tailored from a pasted posting store that posting, its hash (a rerun of
the same posting updates its document instead of adding another), the match
score and where the request came from, so Documents can search and show it.

Revision ID: 083_resume_doc_job_description
Revises: 082_llm_usage_events
Create Date: 2026-10-06
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "083_resume_doc_job_description"
down_revision = "082_llm_usage_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("resume_documents", sa.Column("job_description", sa.Text(), nullable=True))
    op.add_column("resume_documents", sa.Column("job_description_hash", sa.String(64), nullable=True))
    op.add_column("resume_documents", sa.Column("match_score", sa.Integer(), nullable=True))
    op.add_column("resume_documents", sa.Column("origin", sa.String(20), nullable=True))
    op.create_index(
        "ix_resume_documents_user_jd_hash",
        "resume_documents",
        ["user_id", "job_description_hash"],
    )


def downgrade() -> None:
    op.drop_index("ix_resume_documents_user_jd_hash", table_name="resume_documents")
    op.drop_column("resume_documents", "origin")
    op.drop_column("resume_documents", "match_score")
    op.drop_column("resume_documents", "job_description_hash")
    op.drop_column("resume_documents", "job_description")
