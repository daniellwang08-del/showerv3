"""Record which engine produced each match score and what it read.

A stored score currently cannot be re-derived: there is no record of the
engine, the scorer calibration, or the encodings it read. That makes a
disagreeing re-score ambiguous between a scorer change and encoding drift,
which in turn makes tuning unmeasurable.

Revision ID: 067_match_result_provenance
Revises: 066_ind_domain_vecs
Create Date: 2026-09-08
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "067_match_result_provenance"
down_revision = "066_ind_domain_vecs"
branch_labels = None
depends_on = None


_COLUMNS = (
    ("match_engine", sa.String(length=20)),
    ("scorer_version", sa.String(length=50)),
    ("model_version", sa.String(length=200)),
    ("inputs_fingerprint", sa.String(length=64)),
    ("updated_at", sa.DateTime()),
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "job_match_results" not in set(inspector.get_table_names()):
        return

    existing = {c["name"] for c in inspector.get_columns("job_match_results")}
    for name, type_ in _COLUMNS:
        if name not in existing:
            op.add_column(
                "job_match_results", sa.Column(name, type_, nullable=True)
            )

    indexes = {i["name"] for i in inspector.get_indexes("job_match_results")}
    if "ix_job_match_results_match_engine" not in indexes:
        op.create_index(
            "ix_job_match_results_match_engine",
            "job_match_results",
            ["match_engine"],
        )

    # Backfill the historical split. The vector scorer landed 2026-09-02
    # (385f2d5); everything scored before that came from the LLM path. This is
    # the last point at which that inference is available, so record it now
    # rather than leaving the rows permanently unattributable.
    op.execute(
        """
        UPDATE job_match_results
           SET match_engine = CASE
                 WHEN created_at < TIMESTAMP '2026-09-02' THEN 'llm'
                 ELSE 'vector'
               END
         WHERE match_engine IS NULL
        """
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "job_match_results" not in set(inspector.get_table_names()):
        return

    indexes = {i["name"] for i in inspector.get_indexes("job_match_results")}
    if "ix_job_match_results_match_engine" in indexes:
        op.drop_index(
            "ix_job_match_results_match_engine", table_name="job_match_results"
        )

    existing = {c["name"] for c in inspector.get_columns("job_match_results")}
    for name, _ in reversed(_COLUMNS):
        if name in existing:
            op.drop_column("job_match_results", name)
