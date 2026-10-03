"""Library resumes can carry the cover letter generated with them.

Resumes tailored from a pasted job description on the Documents page keep the
matching cover letter body so both files download from one place.

Revision ID: 070_resume_document_cover_letter
Revises: 069_auto_score_default_on
Create Date: 2026-10-03
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "070_resume_document_cover_letter"
down_revision = "069_auto_score_default_on"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("resume_documents", sa.Column("cover_letter", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("resume_documents", "cover_letter")
