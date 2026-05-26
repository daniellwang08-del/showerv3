"""Add profile_source_documents for per-company project source material.

Revision ID: 033_profile_source_documents
Revises: 032_user_resume_template
Create Date: 2026-05-26
"""

from alembic import op
import sqlalchemy as sa

revision = "033_profile_source_documents"
down_revision = "032_user_resume_template"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "profile_source_documents" in inspector.get_table_names():
        return

    op.create_table(
        "profile_source_documents",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("filename", sa.String(500), nullable=False),
        sa.Column("source_kind", sa.String(20), nullable=False),
        sa.Column("company_name", sa.String(200), nullable=True),
        sa.Column("extracted_text", sa.Text(), nullable=True),
        sa.Column("structured_data", sa.JSON(), nullable=True),
        sa.Column("char_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("project_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("parse_status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("parse_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_psd_user_id", "profile_source_documents", ["user_id"])
    op.create_index("ix_psd_user_parse_status", "profile_source_documents", ["user_id", "parse_status"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "profile_source_documents" not in inspector.get_table_names():
        return
    op.drop_index("ix_psd_user_parse_status", table_name="profile_source_documents")
    op.drop_index("ix_psd_user_id", table_name="profile_source_documents")
    op.drop_table("profile_source_documents")
