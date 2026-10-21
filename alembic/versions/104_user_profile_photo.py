"""Optional profile photo on users, stored as an image data URL.

Revision ID: 104_user_profile_photo
Revises: 103_team_multi_membership
Create Date: 2026-10-21
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "104_user_profile_photo"
down_revision = "103_team_multi_membership"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("users")}
    if "profile_photo" not in columns:
        op.add_column("users", sa.Column("profile_photo", sa.Text(), nullable=True))


def downgrade() -> None:
    columns = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("users")}
    if "profile_photo" in columns:
        op.drop_column("users", "profile_photo")
