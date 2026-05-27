"""Add per-user cover letter prompt settings to users.

Revision ID: 035_cover_letter_prompt
Revises: 034_user_cover_letter_template
Create Date: 2026-05-26
"""

from alembic import op
import sqlalchemy as sa

revision = "035_cover_letter_prompt"
down_revision = "034_user_cover_letter_template"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    if "cover_letter_prompt_mode" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "cover_letter_prompt_mode",
                sa.String(20),
                nullable=False,
                server_default="default",
            ),
        )
    if "cover_letter_prompt_custom" not in columns:
        op.add_column(
            "users",
            sa.Column("cover_letter_prompt_custom", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    if "cover_letter_prompt_custom" in columns:
        op.drop_column("users", "cover_letter_prompt_custom")
    if "cover_letter_prompt_mode" in columns:
        op.drop_column("users", "cover_letter_prompt_mode")
