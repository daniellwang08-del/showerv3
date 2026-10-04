"""Chunk vectors, role signals and encoder version on job/user encodings.

The v4 vector scorer compares postings and profiles line by line and reads
deterministic role family, specialty, seniority and page-validity signals.
encoder_version lets the backfill find rows written by an older encoder.

Revision ID: 072_match_engine_v4_signals
Revises: 071_perf_indexes
Create Date: 2026-10-04
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "072_match_engine_v4_signals"
down_revision = "071_perf_indexes"
branch_labels = None
depends_on = None

_TABLES = ("job_encodings", "user_encodings")


def upgrade() -> None:
    for table in _TABLES:
        op.add_column(table, sa.Column("chunk_vecs", sa.LargeBinary(), nullable=True))
        op.add_column(table, sa.Column("signals", sa.JSON(), nullable=True))
        op.add_column(table, sa.Column("encoder_version", sa.String(40), nullable=True))


def downgrade() -> None:
    for table in _TABLES:
        op.drop_column(table, "encoder_version")
        op.drop_column(table, "signals")
        op.drop_column(table, "chunk_vecs")
