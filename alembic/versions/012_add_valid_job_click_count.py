"""Add click_count to valid_jobs for tracking job URL clicks

Revision ID: 012_click_count
Revises: 011_job_match_progress
Create Date: 2026-02-27

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "012_click_count"
down_revision: Union[str, None] = "011_job_match_progress"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("valid_jobs", sa.Column("click_count", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("valid_jobs", "click_count")
