"""Per-user résumé source for applications (original or tailored).

Revision ID: 079_application_resume_source
Revises: 078_job_add_batches
Create Date: 2026-10-05
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "079_application_resume_source"
down_revision = "078_job_add_batches"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {c["name"] for c in sa.inspect(bind).get_columns("users")}
    if "application_resume_source" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "application_resume_source",
                sa.String(length=20),
                nullable=False,
                server_default="tailored",
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    columns = {c["name"] for c in sa.inspect(bind).get_columns("users")}
    if "application_resume_source" in columns:
        op.drop_column("users", "application_resume_source")
