"""Per-user tailored resume / cover letter filename pattern.

Users can pick a static download name or a token rule such as
``{firstname}_{lastname}_{kind}`` (separators ``_``, ``-``, or ``.``).

Revision ID: 077_resume_filename_pattern
Revises: 076_signup_approval
Create Date: 2026-10-05
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "077_resume_filename_pattern"
down_revision = "076_signup_approval"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    if "resume_filename_mode" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "resume_filename_mode",
                sa.String(length=20),
                nullable=False,
                server_default="pattern",
            ),
        )
    if "resume_filename_value" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "resume_filename_value",
                sa.String(length=200),
                nullable=False,
                server_default="{firstname}_{lastname}_{kind}",
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    if "resume_filename_value" in columns:
        op.drop_column("users", "resume_filename_value")
    if "resume_filename_mode" in columns:
        op.drop_column("users", "resume_filename_mode")
