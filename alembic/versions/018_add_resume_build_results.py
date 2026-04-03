"""Add resume_build_results table for tailored resume/cover letter generation.

Revision ID: 018_resume_build_results
Revises: 017_is_job_posting
Create Date: 2026-04-03
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "018_resume_build_results"
down_revision: str | None = "017_is_job_posting"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "resume_build_results",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("valid_job_id", sa.String(36), sa.ForeignKey("valid_jobs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("resume_docx_status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("resume_pdf_status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("cover_letter_docx_status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("cover_letter_pdf_status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("resume_docx_path", sa.Text(), nullable=True),
        sa.Column("resume_pdf_path", sa.Text(), nullable=True),
        sa.Column("cover_letter_docx_path", sa.Text(), nullable=True),
        sa.Column("cover_letter_pdf_path", sa.Text(), nullable=True),
        sa.Column("tailored_resume_data", sa.JSON(), nullable=True),
        sa.Column("cover_letter_data", sa.JSON(), nullable=True),
        sa.Column("output_directory", sa.Text(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("valid_job_id", "user_id", name="uq_resume_build_valid_job_user"),
    )
    op.create_index("ix_resume_build_results_valid_job_id", "resume_build_results", ["valid_job_id"])
    op.create_index("ix_resume_build_results_user_id", "resume_build_results", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_resume_build_results_user_id", table_name="resume_build_results")
    op.drop_index("ix_resume_build_results_valid_job_id", table_name="resume_build_results")
    op.drop_table("resume_build_results")
