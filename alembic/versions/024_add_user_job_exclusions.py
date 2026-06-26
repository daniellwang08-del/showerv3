"""Create user_job_exclusions table for per-user company-policy demotions.

Previously, enforce_company_priority_after_match() physically moved ValidJob
rows to invalid_jobs (setting is_active=False globally), which broke
multi-user isolation - one user's analysis could permanently hide jobs for
all other users.

This table stores per-user policy decisions so that:
  • valid_jobs.is_active is NEVER modified by company policy (only content dedup)
  • Each user has an independent view of which jobs are excluded
  • Users can restore any exclusion without affecting other users

exclusion_type values:
  'applied_company'          – user already applied to this company
  'lower_score'              – lower match score than best for this company
  'superseded_by_higher'     – replaced by a higher-scoring job at same company
  'no_score_comparison'      – first analyzed at company; others auto-excluded
  'recycled_applied_company' – was excluded but recycle period passed; now valid

Revision ID: 024_add_user_job_exclusions
Revises: 023_add_raw_plain_text_to_job_extractions
Create Date: 2026-05-20
"""

from alembic import op
import sqlalchemy as sa

revision = "024_user_job_exclusions"
down_revision = "023_raw_plain_text"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_job_exclusions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "valid_job_id",
            sa.String(36),
            sa.ForeignKey("valid_jobs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "excluded_because_job_id",
            sa.String(36),
            sa.ForeignKey("valid_jobs.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("exclusion_type", sa.String(50), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("similarity_score", sa.Float(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_uje_user_id", "user_job_exclusions", ["user_id"])
    op.create_index("ix_uje_valid_job_id", "user_job_exclusions", ["valid_job_id"])
    op.create_index(
        "ix_uje_because_job_id",
        "user_job_exclusions",
        ["excluded_because_job_id"],
    )
    op.create_unique_constraint(
        "uq_user_job_exclusion",
        "user_job_exclusions",
        ["user_id", "valid_job_id"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_user_job_exclusion", "user_job_exclusions", type_="unique")
    op.drop_index("ix_uje_because_job_id", table_name="user_job_exclusions")
    op.drop_index("ix_uje_valid_job_id", table_name="user_job_exclusions")
    op.drop_index("ix_uje_user_id", table_name="user_job_exclusions")
    op.drop_table("user_job_exclusions")
