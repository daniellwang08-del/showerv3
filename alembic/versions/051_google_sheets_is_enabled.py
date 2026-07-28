"""Add is_enabled soft toggle to google_sheets_config.

Revision ID: 051_google_sheets_is_enabled
Revises: 050_llm_provider_keys
Create Date: 2026-07-13

Disabling Google Sheets auto-post must preserve spreadsheet URL and tab groups.
Previously the UI deleted the whole config row when "Enable" was unchecked.
"""

from alembic import op
import sqlalchemy as sa


revision = "051_google_sheets_is_enabled"
down_revision = "050_llm_provider_keys"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "google_sheets_config" not in tables:
        return
    cols = {c["name"] for c in inspector.get_columns("google_sheets_config")}
    if "is_enabled" in cols:
        return
    op.add_column(
        "google_sheets_config",
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "google_sheets_config" not in tables:
        return
    cols = {c["name"] for c in inspector.get_columns("google_sheets_config")}
    if "is_enabled" not in cols:
        return
    op.drop_column("google_sheets_config", "is_enabled")
