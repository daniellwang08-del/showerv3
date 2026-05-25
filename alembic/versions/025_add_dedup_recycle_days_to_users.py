"""Add dedup_recycle_days to users table.

Controls how many days must pass since an old job's posting date before a new
job at the same company is considered fresh (not a duplicate) even if the user
already applied to a prior posting there.  Default is 60 days (≈ 2 months).

For example: if a user applied to "Software Engineer at Google" 90 days ago and
a new "Software Engineer at Google" role appears, and their recycle_days = 60,
the new job is treated as valid (recycled) rather than automatically excluded.

Revision ID: 025_add_dedup_recycle_days_to_users
Revises: 024_add_user_job_exclusions
Create Date: 2026-05-20
"""

from alembic import op
import sqlalchemy as sa

revision = "025_dedup_recycle_days"
down_revision = "024_user_job_exclusions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "dedup_recycle_days",
            sa.Integer(),
            nullable=False,
            server_default="60",
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "dedup_recycle_days")
