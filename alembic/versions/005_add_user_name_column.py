"""Add name column to users table

Revision ID: 005_user_name
Revises: 004_widen_varchar
Create Date: 2026-02-27

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "005_user_name"
down_revision: Union[str, None] = "004_widen_varchar"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("name", sa.String(100), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "name")
