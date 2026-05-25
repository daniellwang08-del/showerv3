"""Add google_sheets_config table and sheet_posted_at column on valid_jobs.

Revision ID: 019_google_sheets
Revises: 018_resume_build_results
Create Date: 2026-04-15
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "019_google_sheets"
down_revision: str | None = "018_resume_build_results"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "google_sheets_config",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True),
        sa.Column("spreadsheet_url", sa.Text(), nullable=False),
        sa.Column("spreadsheet_id", sa.String(255), nullable=False),
        sa.Column("tab_groups", sa.JSON(), nullable=True),
        sa.Column("round_robin_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("auto_post_threshold", sa.Integer(), nullable=False, server_default="75"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_google_sheets_config_user_id", "google_sheets_config", ["user_id"])

    op.add_column("valid_jobs", sa.Column("sheet_posted_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("valid_jobs", "sheet_posted_at")
    op.drop_index("ix_google_sheets_config_user_id", table_name="google_sheets_config")
    op.drop_table("google_sheets_config")
