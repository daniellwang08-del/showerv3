"""Add profile_openai_cache column for cached OpenAI input

Revision ID: 009_openai_cache
Revises: 008_single_profile
Create Date: 2026-02-27

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "009_openai_cache"
down_revision: Union[str, None] = "008_single_profile"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("profile_openai_cache", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "profile_openai_cache")
