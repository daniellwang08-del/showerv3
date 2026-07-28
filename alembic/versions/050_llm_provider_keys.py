"""Add LLM provider key pool and per-job key bindings for admin System Settings.

Revision ID: 050_llm_provider_keys
Revises: 049_admin_system_tables
Create Date: 2026-07-10
"""

from alembic import op
import sqlalchemy as sa

revision = "050_llm_provider_keys"
down_revision = "049_admin_system_tables"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "llm_provider_keys" not in tables:
        op.create_table(
            "llm_provider_keys",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("provider", sa.String(20), nullable=False, index=True),
            sa.Column("label", sa.String(100), nullable=False),
            sa.Column("api_key_encrypted", sa.Text(), nullable=False),
            sa.Column("key_hint", sa.String(32), nullable=True),
            sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
            sa.Column("created_by_user_id", sa.String(36), nullable=True),
        )
        op.create_index(
            "ix_llm_provider_keys_provider_label",
            "llm_provider_keys",
            ["provider", "label"],
            unique=True,
        )

    if "llm_job_bindings" not in tables:
        op.create_table(
            "llm_job_bindings",
            sa.Column("job_type", sa.String(50), primary_key=True),
            sa.Column("provider_key_id", sa.String(36), nullable=True),
            sa.Column("provider", sa.String(20), nullable=True),
            sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_by_user_id", sa.String(36), nullable=True),
            sa.ForeignKeyConstraint(
                ["provider_key_id"],
                ["llm_provider_keys.id"],
                ondelete="SET NULL",
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "llm_job_bindings" in tables:
        op.drop_table("llm_job_bindings")
    if "llm_provider_keys" in tables:
        op.drop_index("ix_llm_provider_keys_provider_label", table_name="llm_provider_keys")
        op.drop_table("llm_provider_keys")
