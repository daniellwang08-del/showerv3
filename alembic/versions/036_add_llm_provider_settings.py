"""Add per-user LLM provider selection and Anthropic/Gemini BYO key columns.

Revision ID: 036_llm_provider
Revises: 035_cover_letter_prompt
Create Date: 2026-06-17
"""

from alembic import op
import sqlalchemy as sa

revision = "036_llm_provider"
down_revision = "035_cover_letter_prompt"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    if "llm_provider" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "llm_provider",
                sa.String(20),
                nullable=False,
                server_default="openai",
            ),
        )
    if "anthropic_key_mode" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "anthropic_key_mode",
                sa.String(20),
                nullable=False,
                server_default="default",
            ),
        )
    if "anthropic_api_key_encrypted" not in columns:
        op.add_column(
            "users",
            sa.Column("anthropic_api_key_encrypted", sa.Text(), nullable=True),
        )
    if "gemini_key_mode" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "gemini_key_mode",
                sa.String(20),
                nullable=False,
                server_default="default",
            ),
        )
    if "gemini_api_key_encrypted" not in columns:
        op.add_column(
            "users",
            sa.Column("gemini_api_key_encrypted", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    if "gemini_api_key_encrypted" in columns:
        op.drop_column("users", "gemini_api_key_encrypted")
    if "gemini_key_mode" in columns:
        op.drop_column("users", "gemini_key_mode")
    if "anthropic_api_key_encrypted" in columns:
        op.drop_column("users", "anthropic_api_key_encrypted")
    if "anthropic_key_mode" in columns:
        op.drop_column("users", "anthropic_key_mode")
    if "llm_provider" in columns:
        op.drop_column("users", "llm_provider")
