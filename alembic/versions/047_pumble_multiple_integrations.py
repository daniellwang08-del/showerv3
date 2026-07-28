"""Allow multiple Pumble integrations per user.

Revision ID: 047_pumble_multiple
Revises: 046_pumble_integration
Create Date: 2026-07-09
"""

from alembic import op
import sqlalchemy as sa

revision = "047_pumble_multiple"
down_revision = "046_pumble_integration"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("pumble_config")}

    if "label" not in columns:
        op.add_column("pumble_config", sa.Column("label", sa.String(255), nullable=True))
    if "is_enabled" not in columns:
        op.add_column(
            "pumble_config",
            sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        )

    # Drop single-integration unique constraint on user_id if present.
    for uc in inspector.get_unique_constraints("pumble_config"):
        if uc.get("column_names") == ["user_id"]:
            op.drop_constraint(uc["name"], "pumble_config", type_="unique")
            break

    existing_ucs = {uc["name"] for uc in inspector.get_unique_constraints("pumble_config")}
    if "uq_pumble_config_user_channel" not in existing_ucs:
        op.create_unique_constraint(
            "uq_pumble_config_user_channel",
            "pumble_config",
            ["user_id", "channel_id"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_ucs = {uc["name"] for uc in inspector.get_unique_constraints("pumble_config")}
    if "uq_pumble_config_user_channel" in existing_ucs:
        op.drop_constraint("uq_pumble_config_user_channel", "pumble_config", type_="unique")

    columns = {c["name"] for c in inspector.get_columns("pumble_config")}
    if "is_enabled" in columns:
        op.drop_column("pumble_config", "is_enabled")
    if "label" in columns:
        op.drop_column("pumble_config", "label")
