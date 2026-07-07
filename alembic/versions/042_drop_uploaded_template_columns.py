"""Drop uploaded-.docx résumé/cover-letter template columns.

The uploaded-template tailoring feature has been removed; every résumé and cover letter
is now compiled from the user's Resume Builder design. These columns existed only for the
upload/analyze/validate bookkeeping and are no longer used.

Revision ID: 042_drop_uploaded_tpl_cols
Revises: 041_resume_template_design
Create Date: 2026-06-29
"""

from alembic import op
import sqlalchemy as sa

revision = "042_drop_uploaded_tpl_cols"
down_revision = "041_resume_template_design"
branch_labels = None
depends_on = None


_DROP = [
    "resume_template_source_path",
    "resume_template_source_filename",
    "resume_template_profile_work_count",
    "resume_template_analyzed_at",
    "cover_letter_template_source_path",
    "cover_letter_template_source_filename",
    "cover_letter_template_detected_tags",
    "cover_letter_template_analyzed_at",
]


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}
    for name in _DROP:
        if name in columns:
            op.drop_column("users", name)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}
    add = {
        "resume_template_source_path": sa.Column("resume_template_source_path", sa.Text(), nullable=True),
        "resume_template_source_filename": sa.Column("resume_template_source_filename", sa.String(length=500), nullable=True),
        "resume_template_profile_work_count": sa.Column("resume_template_profile_work_count", sa.Integer(), nullable=True),
        "resume_template_analyzed_at": sa.Column("resume_template_analyzed_at", sa.DateTime(), nullable=True),
        "cover_letter_template_source_path": sa.Column("cover_letter_template_source_path", sa.Text(), nullable=True),
        "cover_letter_template_source_filename": sa.Column("cover_letter_template_source_filename", sa.String(length=500), nullable=True),
        "cover_letter_template_detected_tags": sa.Column("cover_letter_template_detected_tags", sa.JSON(), nullable=True),
        "cover_letter_template_analyzed_at": sa.Column("cover_letter_template_analyzed_at", sa.DateTime(), nullable=True),
    }
    for name, col in add.items():
        if name not in columns:
            op.add_column("users", col)
