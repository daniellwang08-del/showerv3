"""Job add history, share scopes, and default share preference.

Revision ID: 078_job_add_batches
Revises: 077_resume_filename_pattern
Create Date: 2026-10-05
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "078_job_add_batches"
down_revision = "077_resume_filename_pattern"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("job_share_default", sa.String(16), nullable=False, server_default="private"),
    )

    op.create_table(
        "job_add_batches",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source", sa.String(32), nullable=False, server_default="manual"),
        sa.Column("job_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("share_scope", sa.String(16), nullable=False, server_default="private"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_job_add_batches_user_id", "job_add_batches", ["user_id"])
    op.create_index(
        "ix_job_add_batches_user_created",
        "job_add_batches",
        ["user_id", "created_at"],
    )

    op.create_table(
        "job_add_batch_jobs",
        sa.Column(
            "batch_id",
            sa.String(36),
            sa.ForeignKey("job_add_batches.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "job_id",
            sa.String(36),
            sa.ForeignKey("jobs.id", ondelete="CASCADE"),
            primary_key=True,
        ),
    )
    op.create_index("ix_job_add_batch_jobs_job_id", "job_add_batch_jobs", ["job_id"])

    op.create_table(
        "job_add_batch_share_users",
        sa.Column(
            "batch_id",
            sa.String(36),
            sa.ForeignKey("job_add_batches.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
    )


def downgrade() -> None:
    op.drop_table("job_add_batch_share_users")
    op.drop_index("ix_job_add_batch_jobs_job_id", table_name="job_add_batch_jobs")
    op.drop_table("job_add_batch_jobs")
    op.drop_index("ix_job_add_batches_user_created", table_name="job_add_batches")
    op.drop_index("ix_job_add_batches_user_id", table_name="job_add_batches")
    op.drop_table("job_add_batches")
    op.drop_column("users", "job_share_default")
