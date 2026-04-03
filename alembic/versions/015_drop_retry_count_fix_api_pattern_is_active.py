"""Drop retry_count from job_extractions and fix api_pattern_registry.is_active to Boolean.

Revision ID: 015_cleanup_columns
Revises: 014_drop_url_uniqueness
Create Date: 2026-04-03
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "015_cleanup_columns"
down_revision: Union[str, None] = "014_drop_url_uniqueness"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_column("job_extractions", "retry_count")

    op.alter_column(
        "api_pattern_registry",
        "is_active",
        existing_type=sa.Float(),
        type_=sa.Boolean(),
        existing_nullable=True,
        postgresql_using="is_active::int::boolean",
        server_default=sa.text("true"),
    )


def downgrade() -> None:
    op.alter_column(
        "api_pattern_registry",
        "is_active",
        existing_type=sa.Boolean(),
        type_=sa.Float(),
        existing_nullable=True,
        postgresql_using="is_active::int::float",
        server_default=sa.text("1"),
    )

    op.add_column(
        "job_extractions",
        sa.Column("retry_count", sa.Float(), server_default=sa.text("0")),
    )
