"""Widen job_extractions VARCHAR columns to prevent truncation errors

Revision ID: 004_widen_varchar
Revises: 003_scraped
Create Date: 2026-02-27

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "004_widen_varchar"
down_revision: Union[str, None] = "003_scraped"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "job_extractions",
        "remote_policy",
        existing_type=sa.String(100),
        type_=sa.String(500),
        existing_nullable=True,
    )
    op.alter_column(
        "job_extractions",
        "experience_level",
        existing_type=sa.String(100),
        type_=sa.String(500),
        existing_nullable=True,
    )
    op.alter_column(
        "job_extractions",
        "employment_type",
        existing_type=sa.String(100),
        type_=sa.String(500),
        existing_nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "job_extractions",
        "remote_policy",
        existing_type=sa.String(500),
        type_=sa.String(100),
        existing_nullable=True,
    )
    op.alter_column(
        "job_extractions",
        "experience_level",
        existing_type=sa.String(500),
        type_=sa.String(100),
        existing_nullable=True,
    )
    op.alter_column(
        "job_extractions",
        "employment_type",
        existing_type=sa.String(500),
        type_=sa.String(100),
        existing_nullable=True,
    )
