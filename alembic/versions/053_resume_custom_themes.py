"""Add custom resume themes + per-user theme loves.

Revision ID: 053_resume_custom_themes
Revises: 052_auto_post_filters
Create Date: 2026-07-22
"""

from alembic import op
import sqlalchemy as sa


revision = "053_resume_custom_themes"
down_revision = "052_auto_post_filters"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "resume_custom_themes" not in tables:
        op.create_table(
            "resume_custom_themes",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column(
                "user_id",
                sa.String(length=36),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("name", sa.String(length=200), nullable=False),
            sa.Column("description", sa.String(length=500), nullable=False, server_default="Custom theme"),
            sa.Column("accent_swatch", sa.String(length=32), nullable=False, server_default="#2563eb"),
            sa.Column("design", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        )
        op.create_index("ix_resume_custom_themes_user_id", "resume_custom_themes", ["user_id"])

    if "resume_theme_loves" not in tables:
        op.create_table(
            "resume_theme_loves",
            sa.Column(
                "user_id",
                sa.String(length=36),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                primary_key=True,
                nullable=False,
            ),
            sa.Column("theme_id", sa.String(length=64), primary_key=True, nullable=False),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        )
        op.create_index("ix_resume_theme_loves_user_id", "resume_theme_loves", ["user_id"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "resume_theme_loves" in tables:
        op.drop_index("ix_resume_theme_loves_user_id", table_name="resume_theme_loves")
        op.drop_table("resume_theme_loves")
    if "resume_custom_themes" in tables:
        op.drop_index("ix_resume_custom_themes_user_id", table_name="resume_custom_themes")
        op.drop_table("resume_custom_themes")
