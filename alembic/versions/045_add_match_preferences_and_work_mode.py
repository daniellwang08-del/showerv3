"""Add job_match_preferences to users and work_mode to job_extractions/jobs.

Revision ID: 045_match_prefs_work_mode
Revises: 044_backfill_resume_design_mirror
Create Date: 2026-07-08
"""

from alembic import op
import sqlalchemy as sa

revision = "045_match_prefs_work_mode"
down_revision = "044_backfill_design_mirror"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    user_columns = {c["name"] for c in inspector.get_columns("users")}
    if "job_match_preferences" not in user_columns:
        op.add_column("users", sa.Column("job_match_preferences", sa.Text(), nullable=True))

    extraction_columns = {c["name"] for c in inspector.get_columns("job_extractions")}
    if "work_mode" not in extraction_columns:
        op.add_column("job_extractions", sa.Column("work_mode", sa.String(length=20), nullable=True))

    job_columns = {c["name"] for c in inspector.get_columns("jobs")}
    if "work_mode" not in job_columns:
        op.add_column("jobs", sa.Column("work_mode", sa.String(length=20), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    job_columns = {c["name"] for c in inspector.get_columns("jobs")}
    if "work_mode" in job_columns:
        op.drop_column("jobs", "work_mode")

    extraction_columns = {c["name"] for c in inspector.get_columns("job_extractions")}
    if "work_mode" in extraction_columns:
        op.drop_column("job_extractions", "work_mode")

    user_columns = {c["name"] for c in inspector.get_columns("users")}
    if "job_match_preferences" in user_columns:
        op.drop_column("users", "job_match_preferences")
