"""Add per-user resume tailoring prompt settings to users.

Revision ID: 030_resume_tailoring_prompt
Revises: 029_min_match_score
Create Date: 2026-05-22
"""

from alembic import op
import sqlalchemy as sa

revision = "030_resume_tailoring_prompt"
down_revision = "029_min_match_score"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    if "resume_tailoring_prompt_mode" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "resume_tailoring_prompt_mode",
                sa.String(20),
                nullable=False,
                server_default="default",
            ),
        )
    if "resume_tailoring_prompt_custom" not in columns:
        op.add_column(
            "users",
            sa.Column("resume_tailoring_prompt_custom", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    if "resume_tailoring_prompt_custom" in columns:
        op.drop_column("users", "resume_tailoring_prompt_custom")
    if "resume_tailoring_prompt_mode" in columns:
        op.drop_column("users", "resume_tailoring_prompt_mode")
