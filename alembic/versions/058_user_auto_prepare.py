"""Per-user auto-prepare prefs (match / full apply-ready).

Revision ID: 058_user_auto_prepare
Revises: 057_user_dedup_rule_prefs
Create Date: 2026-08-08
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "058_user_auto_prepare"
down_revision = "057_user_dedup_rule_prefs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    if "auto_prepare_match" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "auto_prepare_match",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )
    if "auto_prepare_full" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "auto_prepare_full",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )

    # Helpful for fan-out queries.
    indexes = {i["name"] for i in inspector.get_indexes("users") if i.get("name")}
    if "ix_users_auto_prepare_match" not in indexes:
        op.create_index(
            "ix_users_auto_prepare_match",
            "users",
            ["auto_prepare_match"],
            postgresql_where=sa.text("auto_prepare_match IS TRUE"),
        )
    if "ix_users_auto_prepare_full" not in indexes:
        op.create_index(
            "ix_users_auto_prepare_full",
            "users",
            ["auto_prepare_full"],
            postgresql_where=sa.text("auto_prepare_full IS TRUE"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    indexes = {i["name"] for i in inspector.get_indexes("users") if i.get("name")}
    columns = {c["name"] for c in inspector.get_columns("users")}

    if "ix_users_auto_prepare_full" in indexes:
        op.drop_index("ix_users_auto_prepare_full", table_name="users")
    if "ix_users_auto_prepare_match" in indexes:
        op.drop_index("ix_users_auto_prepare_match", table_name="users")
    if "auto_prepare_full" in columns:
        op.drop_column("users", "auto_prepare_full")
    if "auto_prepare_match" in columns:
        op.drop_column("users", "auto_prepare_match")
