"""Per-user LLM quality check of free match scores.

Revision ID: 080_match_quality_check
Revises: 079_application_resume_source
Create Date: 2026-10-05
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "080_match_quality_check"
down_revision = "079_application_resume_source"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {c["name"] for c in sa.inspect(bind).get_columns("users")}
    if "match_quality_check" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "match_quality_check",
                sa.String(length=20),
                nullable=False,
                server_default="rescore",
            ),
        )
    if "match_quality_check_min_score" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "match_quality_check_min_score",
                sa.Integer(),
                nullable=False,
                server_default="70",
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    columns = {c["name"] for c in sa.inspect(bind).get_columns("users")}
    for name in ("match_quality_check_min_score", "match_quality_check"):
        if name in columns:
            op.drop_column("users", name)
