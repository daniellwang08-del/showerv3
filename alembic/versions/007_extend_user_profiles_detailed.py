"""Extend user_profiles with detailed profile fields

Revision ID: 007_profile_detail
Revises: 006_user_profiles
Create Date: 2026-02-27

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "007_profile_detail"
down_revision: Union[str, None] = "006_user_profiles"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("user_profiles", sa.Column("name_first", sa.String(100), nullable=True))
    op.add_column("user_profiles", sa.Column("name_middle", sa.String(100), nullable=True))
    op.add_column("user_profiles", sa.Column("name_last", sa.String(100), nullable=True))
    op.add_column("user_profiles", sa.Column("title", sa.String(200), nullable=True))
    op.add_column("user_profiles", sa.Column("email", sa.String(255), nullable=True))
    op.add_column("user_profiles", sa.Column("phone_country_code", sa.String(10), nullable=True))
    op.add_column("user_profiles", sa.Column("phone_number", sa.String(30), nullable=True))
    op.add_column("user_profiles", sa.Column("linkedin_url", sa.String(500), nullable=True))
    op.add_column("user_profiles", sa.Column("github_url", sa.String(500), nullable=True))
    op.add_column("user_profiles", sa.Column("profile_summary", sa.Text(), nullable=True))
    op.add_column("user_profiles", sa.Column("technical_skills", sa.JSON(), nullable=True))
    op.add_column("user_profiles", sa.Column("work_experience", sa.JSON(), nullable=True))
    op.add_column("user_profiles", sa.Column("education", sa.JSON(), nullable=True))
    op.add_column("user_profiles", sa.Column("certificates", sa.JSON(), nullable=True))
    op.add_column("user_profiles", sa.Column("extra", sa.JSON(), nullable=True))


def downgrade() -> None:
    for col in ["extra", "certificates", "education", "work_experience", "technical_skills",
                "profile_summary", "github_url", "linkedin_url", "phone_number", "phone_country_code",
                "email", "title", "name_last", "name_middle", "name_first"]:
        op.drop_column("user_profiles", col)
