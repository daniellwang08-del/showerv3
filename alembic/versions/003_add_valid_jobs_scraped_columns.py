"""Add extraction_id and scraped_at to valid_jobs

Revision ID: 003_scraped
Revises: 002_add_users_table
Create Date: 2026-02-20

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "003_scraped"
down_revision: Union[str, None] = "002_add_users_table"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("valid_jobs", sa.Column("extraction_id", sa.String(36), nullable=True))
    op.add_column("valid_jobs", sa.Column("scraped_at", sa.DateTime(), nullable=True))
    op.create_index(op.f("ix_valid_jobs_extraction_id"), "valid_jobs", ["extraction_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_valid_jobs_extraction_id"), table_name="valid_jobs")
    op.drop_column("valid_jobs", "scraped_at")
    op.drop_column("valid_jobs", "extraction_id")
