"""Add industry_vec / domain_vec for independent industry scoring.

Revision ID: 066_ind_domain_vecs
Revises: 065_user_job_site_connections
Create Date: 2026-09-04
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "066_ind_domain_vecs"
down_revision = "065_user_job_site_connections"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "job_encodings" in tables:
        cols = {c["name"] for c in inspector.get_columns("job_encodings")}
        if "industry_vec" not in cols:
            op.add_column(
                "job_encodings",
                sa.Column("industry_vec", sa.LargeBinary(), nullable=True),
            )

    if "user_encodings" in tables:
        cols = {c["name"] for c in inspector.get_columns("user_encodings")}
        if "domain_vec" not in cols:
            op.add_column(
                "user_encodings",
                sa.Column("domain_vec", sa.LargeBinary(), nullable=True),
            )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "user_encodings" in tables:
        cols = {c["name"] for c in inspector.get_columns("user_encodings")}
        if "domain_vec" in cols:
            op.drop_column("user_encodings", "domain_vec")
    if "job_encodings" in tables:
        cols = {c["name"] for c in inspector.get_columns("job_encodings")}
        if "industry_vec" in cols:
            op.drop_column("job_encodings", "industry_vec")
