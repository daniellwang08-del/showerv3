"""Per-user applied marks for valid jobs

Revision ID: 013_valid_job_user_applications
Revises: 012_click_count
Create Date: 2026-03-27

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "013_valid_job_user_applications"
down_revision: Union[str, None] = "012_click_count"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "valid_job_user_applications",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("valid_job_id", sa.String(length=36), nullable=False),
        sa.Column("applied_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("applied_by_name", sa.String(length=300), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["valid_job_id"], ["valid_jobs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "valid_job_id", name="uq_valid_job_user_application"),
    )
    op.create_index("ix_valid_job_user_applications_user_id", "valid_job_user_applications", ["user_id"])
    op.create_index("ix_valid_job_user_applications_valid_job_id", "valid_job_user_applications", ["valid_job_id"])
    op.create_index(
        "ix_valid_job_user_applications_user_valid",
        "valid_job_user_applications",
        ["user_id", "valid_job_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_valid_job_user_applications_user_valid", table_name="valid_job_user_applications")
    op.drop_index("ix_valid_job_user_applications_valid_job_id", table_name="valid_job_user_applications")
    op.drop_index("ix_valid_job_user_applications_user_id", table_name="valid_job_user_applications")
    op.drop_table("valid_job_user_applications")
