"""Rename selected_tabs to tab_groups on google_sheets_config (idempotent).

Revision ID: 020_tab_groups
Revises: 019_google_sheets
Create Date: 2026-04-15
"""

from typing import Sequence, Union

from alembic import op
from sqlalchemy import inspect, text

revision: str = "020_tab_groups"
down_revision: str | None = "019_google_sheets"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _column_exists(table: str, column: str) -> bool:
    conn = op.get_bind()
    insp = inspect(conn)
    columns = [c["name"] for c in insp.get_columns(table)]
    return column in columns


def upgrade() -> None:
    if _column_exists("google_sheets_config", "selected_tabs"):
        op.alter_column("google_sheets_config", "selected_tabs", new_column_name="tab_groups")


def downgrade() -> None:
    if _column_exists("google_sheets_config", "tab_groups"):
        op.alter_column("google_sheets_config", "tab_groups", new_column_name="selected_tabs")
