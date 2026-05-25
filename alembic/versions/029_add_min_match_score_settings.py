"""Add per-user minimum match score settings to users.

Revision ID: 029_min_match_score
Revises: 028_user_settings
Create Date: 2026-05-22
"""

from alembic import op
import sqlalchemy as sa

revision = "029_min_match_score"
down_revision = "028_user_settings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    if "min_match_score_mode" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "min_match_score_mode",
                sa.String(20),
                nullable=False,
                server_default="default",
            ),
        )
    if "min_match_score" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "min_match_score",
                sa.Integer(),
                nullable=False,
                server_default="0",
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    if "min_match_score" in columns:
        op.drop_column("users", "min_match_score")
    if "min_match_score_mode" in columns:
        op.drop_column("users", "min_match_score_mode")
