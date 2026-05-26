"""Add per-user resume template fields to users.

Revision ID: 032_user_resume_template
Revises: 031_repair_corrupted_job_titles
Create Date: 2026-05-22
"""

from alembic import op
import sqlalchemy as sa

revision = "032_user_resume_template"
down_revision = "031_repair_corrupted_job_titles"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    additions = [
        ("resume_template_status", sa.String(30), "missing"),
        ("resume_template_source_path", sa.Text(), None),
        ("resume_template_working_path", sa.Text(), None),
        ("resume_template_source_filename", sa.String(500), None),
        ("resume_template_error", sa.Text(), None),
        ("resume_template_profile_work_count", sa.Integer(), None),
    ]
    for name, col_type, default in additions:
        if name not in columns:
            kwargs = {"nullable": True}
            if default is not None:
                kwargs["server_default"] = default
                kwargs["nullable"] = False
            op.add_column("users", sa.Column(name, col_type, **kwargs))

    if "resume_template_blueprint" not in columns:
        op.add_column("users", sa.Column("resume_template_blueprint", sa.JSON(), nullable=True))

    if "resume_template_analyzed_at" not in columns:
        op.add_column("users", sa.Column("resume_template_analyzed_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}
    for name in (
        "resume_template_analyzed_at",
        "resume_template_blueprint",
        "resume_template_profile_work_count",
        "resume_template_error",
        "resume_template_source_filename",
        "resume_template_working_path",
        "resume_template_source_path",
        "resume_template_status",
    ):
        if name in columns:
            op.drop_column("users", name)
