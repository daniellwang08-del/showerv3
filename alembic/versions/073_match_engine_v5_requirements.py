"""Requirement lines and cross-encoder text on job/user encodings.

The v5 vector scorer weighs each posting line by how likely it is a hard
requirement or a nice-to-have and checks the profile line that covers it;
ce_text is the compact pair input for the cross-encoder stage.

Revision ID: 073_match_engine_v5_requirements
Revises: 072_match_engine_v4_signals
Create Date: 2026-10-04
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "073_match_engine_v5_requirements"
down_revision = "072_match_engine_v4_signals"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("job_encodings", sa.Column("req_vecs", sa.LargeBinary(), nullable=True))
    op.add_column("job_encodings", sa.Column("req_lines", sa.JSON(), nullable=True))
    op.add_column("job_encodings", sa.Column("ce_text", sa.Text(), nullable=True))
    op.add_column("user_encodings", sa.Column("chunk_texts", sa.JSON(), nullable=True))
    op.add_column("user_encodings", sa.Column("ce_text", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("user_encodings", "ce_text")
    op.drop_column("user_encodings", "chunk_texts")
    op.drop_column("job_encodings", "ce_text")
    op.drop_column("job_encodings", "req_lines")
    op.drop_column("job_encodings", "req_vecs")
