"""Add work_mode_preferences allow-list on users.

Empty list = any work mode. Non-empty filters the jobs board like
country_preferences filters by location.

Revision ID: 092_work_mode_preferences
Revises: 091_tailoring_default_job_first
Create Date: 2026-10-16
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "092_work_mode_preferences"
down_revision = "091_tailoring_default_job_first"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {c["name"] for c in sa.inspect(bind).get_columns("users")}
    if "work_mode_preferences" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "work_mode_preferences",
                sa.JSON(),
                nullable=False,
                server_default=sa.text("'[]'"),
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    columns = {c["name"] for c in sa.inspect(bind).get_columns("users")}
    if "work_mode_preferences" in columns:
        op.drop_column("users", "work_mode_preferences")
