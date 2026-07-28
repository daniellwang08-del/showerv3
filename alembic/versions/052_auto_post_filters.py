"""Add auto_post_filters JSON to Google Sheets + Pumble configs.

Revision ID: 052_auto_post_filters
Revises: 051_google_sheets_is_enabled
Create Date: 2026-07-13

Stores auto-post filters JSON (work_modes, companies, exclude_companies)
alongside auto_post_threshold.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSON


revision = "052_auto_post_filters"
down_revision = "051_google_sheets_is_enabled"
branch_labels = None
depends_on = None


def _add_json_col(table: str, column: str) -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table not in set(inspector.get_table_names()):
        return
    cols = {c["name"] for c in inspector.get_columns(table)}
    if column in cols:
        return
    op.add_column(
        table,
        sa.Column(column, JSON, nullable=True),
    )


def _drop_col(table: str, column: str) -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table not in set(inspector.get_table_names()):
        return
    cols = {c["name"] for c in inspector.get_columns(table)}
    if column not in cols:
        return
    op.drop_column(table, column)


def upgrade() -> None:
    _add_json_col("google_sheets_config", "auto_post_filters")
    _add_json_col("pumble_config", "auto_post_filters")


def downgrade() -> None:
    _drop_col("pumble_config", "auto_post_filters")
    _drop_col("google_sheets_config", "auto_post_filters")
