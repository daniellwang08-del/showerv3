"""Add optional model selection to LLM job bindings.

Revision ID: 054_llm_job_binding_model
Revises: 053_resume_custom_themes
Create Date: 2026-07-22
"""

from alembic import op
import sqlalchemy as sa


revision = "054_llm_job_binding_model"
down_revision = "053_resume_custom_themes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "llm_job_bindings" not in tables:
        return
    columns = {c["name"] for c in inspector.get_columns("llm_job_bindings")}
    if "model" not in columns:
        op.add_column(
            "llm_job_bindings",
            sa.Column("model", sa.String(length=200), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "llm_job_bindings" not in tables:
        return
    columns = {c["name"] for c in inspector.get_columns("llm_job_bindings")}
    if "model" in columns:
        op.drop_column("llm_job_bindings", "model")
