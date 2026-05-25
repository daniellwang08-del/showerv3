"""Add per-user OpenAI key mode and dedup recycle mode to users.

Revision ID: 028_user_settings
Revises: 027_unify_jobs
Create Date: 2026-05-22
"""

from alembic import op
import sqlalchemy as sa

revision = "028_user_settings"
down_revision = "027_unify_jobs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    if "openai_key_mode" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "openai_key_mode",
                sa.String(20),
                nullable=False,
                server_default="default",
            ),
        )
    if "openai_api_key_encrypted" not in columns:
        op.add_column(
            "users",
            sa.Column("openai_api_key_encrypted", sa.Text(), nullable=True),
        )
    if "dedup_recycle_mode" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "dedup_recycle_mode",
                sa.String(20),
                nullable=False,
                server_default="default",
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    if "dedup_recycle_mode" in columns:
        op.drop_column("users", "dedup_recycle_mode")
    if "openai_api_key_encrypted" in columns:
        op.drop_column("users", "openai_api_key_encrypted")
    if "openai_key_mode" in columns:
        op.drop_column("users", "openai_key_mode")
