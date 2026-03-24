"""Merge user_profiles into users (single profile per account)

Revision ID: 008_single_profile
Revises: 007_profile_detail
Create Date: 2026-02-27

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text

revision: str = "008_single_profile"
down_revision: Union[str, None] = "007_profile_detail"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add profile columns to users
    op.add_column("users", sa.Column("name_first", sa.String(100), nullable=True))
    op.add_column("users", sa.Column("name_middle", sa.String(100), nullable=True))
    op.add_column("users", sa.Column("name_last", sa.String(100), nullable=True))
    op.add_column("users", sa.Column("profile_title", sa.String(200), nullable=True))
    op.add_column("users", sa.Column("profile_email", sa.String(255), nullable=True))
    op.add_column("users", sa.Column("phone_country_code", sa.String(10), nullable=True))
    op.add_column("users", sa.Column("phone_number", sa.String(30), nullable=True))
    op.add_column("users", sa.Column("linkedin_url", sa.String(500), nullable=True))
    op.add_column("users", sa.Column("github_url", sa.String(500), nullable=True))
    op.add_column("users", sa.Column("profile_summary", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("technical_skills", sa.JSON(), nullable=True))
    op.add_column("users", sa.Column("work_experience", sa.JSON(), nullable=True))
    op.add_column("users", sa.Column("education", sa.JSON(), nullable=True))
    op.add_column("users", sa.Column("certificates", sa.JSON(), nullable=True))
    op.add_column("users", sa.Column("extra", sa.JSON(), nullable=True))

    # Migrate data from user_profiles (first profile per user)
    conn = op.get_bind()
    conn.execute(text("""
        UPDATE users AS u SET
            name_first = up.name_first,
            name_middle = up.name_middle,
            name_last = up.name_last,
            profile_title = up.title,
            profile_email = up.email,
            phone_country_code = up.phone_country_code,
            phone_number = up.phone_number,
            linkedin_url = up.linkedin_url,
            github_url = up.github_url,
            profile_summary = up.profile_summary,
            technical_skills = up.technical_skills,
            work_experience = up.work_experience,
            education = up.education,
            certificates = up.certificates,
            extra = up.extra
        FROM (
            SELECT DISTINCT ON (user_id) user_id, name_first, name_middle, name_last,
                title, email, phone_country_code, phone_number, linkedin_url, github_url,
                profile_summary, technical_skills, work_experience, education, certificates, extra
            FROM user_profiles
            ORDER BY user_id, created_at DESC
        ) up
        WHERE u.id = up.user_id
    """))

    # Drop user_profiles table
    op.drop_index("ix_user_profiles_user_id", table_name="user_profiles")
    op.drop_table("user_profiles")


def downgrade() -> None:
    op.create_table(
        "user_profiles",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("name_first", sa.String(100), nullable=True),
        sa.Column("name_middle", sa.String(100), nullable=True),
        sa.Column("name_last", sa.String(100), nullable=True),
        sa.Column("title", sa.String(200), nullable=True),
        sa.Column("email", sa.String(255), nullable=True),
        sa.Column("phone_country_code", sa.String(10), nullable=True),
        sa.Column("phone_number", sa.String(30), nullable=True),
        sa.Column("linkedin_url", sa.String(500), nullable=True),
        sa.Column("github_url", sa.String(500), nullable=True),
        sa.Column("profile_summary", sa.Text(), nullable=True),
        sa.Column("technical_skills", sa.JSON(), nullable=True),
        sa.Column("work_experience", sa.JSON(), nullable=True),
        sa.Column("education", sa.JSON(), nullable=True),
        sa.Column("certificates", sa.JSON(), nullable=True),
        sa.Column("extra", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_user_profiles_user_id", "user_profiles", ["user_id"])

    # Copy data back
    conn = op.get_bind()
    conn.execute(text("""
        INSERT INTO user_profiles (id, user_id, name, name_first, name_middle, name_last, title, email,
            phone_country_code, phone_number, linkedin_url, github_url, profile_summary,
            technical_skills, work_experience, education, certificates, extra, created_at, updated_at)
        SELECT gen_random_uuid()::text, id,
            COALESCE(TRIM(name_first || ' ' || COALESCE(name_middle || ' ', '') || name_last), 'Profile'),
            name_first, name_middle, name_last, profile_title, profile_email,
            phone_country_code, phone_number, linkedin_url, github_url, profile_summary,
            technical_skills, work_experience, education, certificates, extra, created_at, updated_at
        FROM users
        WHERE name_first IS NOT NULL OR profile_title IS NOT NULL
    """))

    for col in ["extra", "certificates", "education", "work_experience", "technical_skills",
                "profile_summary", "github_url", "linkedin_url", "phone_number", "phone_country_code",
                "profile_email", "profile_title", "name_last", "name_middle", "name_first"]:
        op.drop_column("users", col)
