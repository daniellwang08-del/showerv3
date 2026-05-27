"""Add per-user cover letter template columns to users.

Revision ID: 034_user_cover_letter_template
Revises: 033_profile_source_documents
Create Date: 2026-05-26
"""

from alembic import op
import sqlalchemy as sa

revision = "034_user_cover_letter_template"
down_revision = "033_profile_source_documents"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    column_defs = [
        ("cover_letter_template_status", sa.String(30), "missing"),
        ("cover_letter_template_source_path", sa.Text(), None),
        ("cover_letter_template_working_path", sa.Text(), None),
        ("cover_letter_template_source_filename", sa.String(500), None),
        ("cover_letter_template_error", sa.Text(), None),
    ]

    for name, col_type, server_default in column_defs:
        if name not in columns:
            kwargs = {"nullable": True}
            if server_default is not None:
                kwargs["server_default"] = server_default
                kwargs["nullable"] = False
            op.add_column("users", sa.Column(name, col_type, **kwargs))

    if "cover_letter_template_analyzed_at" not in columns:
        op.add_column("users", sa.Column("cover_letter_template_analyzed_at", sa.DateTime(), nullable=True))

    if "cover_letter_template_detected_tags" not in columns:
        op.add_column("users", sa.Column("cover_letter_template_detected_tags", sa.JSON(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    for name in (
        "cover_letter_template_detected_tags",
        "cover_letter_template_analyzed_at",
        "cover_letter_template_error",
        "cover_letter_template_source_filename",
        "cover_letter_template_working_path",
        "cover_letter_template_source_path",
        "cover_letter_template_status",
    ):
        if name in columns:
            op.drop_column("users", name)
