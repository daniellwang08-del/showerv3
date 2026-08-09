"""Per-user manual submit pipeline depth (extract / match / full).

Revision ID: 060_manual_submit_pipeline
Revises: 059_admin_manual_added_from
Create Date: 2026-08-09
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "060_manual_submit_pipeline"
down_revision = "059_admin_manual_added_from"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    if "manual_submit_pipeline" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "manual_submit_pipeline",
                sa.String(length=20),
                nullable=False,
                server_default="full",
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}
    if "manual_submit_pipeline" in columns:
        op.drop_column("users", "manual_submit_pipeline")
