"""Add per-user preferred LLM model (OpenAI-compatible gateway).

Revision ID: 055_user_llm_model
Revises: 054_llm_job_binding_model
Create Date: 2026-07-22
"""

from alembic import op
import sqlalchemy as sa


revision = "055_user_llm_model"
down_revision = "054_llm_job_binding_model"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "users" not in tables:
        return
    columns = {c["name"] for c in inspector.get_columns("users")}
    if "llm_model" not in columns:
        op.add_column(
            "users",
            sa.Column("llm_model", sa.String(length=200), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "users" not in tables:
        return
    columns = {c["name"] for c in inspector.get_columns("users")}
    if "llm_model" in columns:
        op.drop_column("users", "llm_model")
