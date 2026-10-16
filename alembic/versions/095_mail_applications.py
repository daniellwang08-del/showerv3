"""Application confirmation emails, counted as applications.

Revision ID: 095_mail_applications
Revises: 094_mail_interviews
Create Date: 2026-10-16
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "095_mail_applications"
down_revision = "094_mail_interviews"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())

    if "mail_applications" not in tables:
        op.create_table(
            "mail_applications",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("company", sa.String(300), nullable=False),
            sa.Column("company_key", sa.String(300), nullable=False),
            sa.Column("role_title", sa.String(300), nullable=True),
            sa.Column("applied_at", sa.DateTime(), nullable=False),
            sa.Column("message_id", sa.String(255), nullable=False),
            sa.Column("thread_id", sa.String(255), nullable=True),
            sa.Column("email_subject", sa.String(500), nullable=True),
            sa.Column("email_from", sa.String(500), nullable=True),
            sa.Column("job_id", sa.String(36), sa.ForeignKey("jobs.id", ondelete="SET NULL"), nullable=True),
            sa.Column("linked_job_ids", sa.JSON(), nullable=True),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
            sa.UniqueConstraint("user_id", "message_id", name="uq_mail_application_user_message"),
        )
        op.create_index("ix_mail_applications_user_id", "mail_applications", ["user_id"])
        op.create_index("ix_mail_applications_user_company", "mail_applications", ["user_id", "company_key"])
        op.create_index("ix_mail_applications_user_applied", "mail_applications", ["user_id", "applied_at"])

    # Earlier syncs dropped confirmation emails; rescan the lookback window once.
    if "mail_connections" in tables:
        op.execute("UPDATE mail_connections SET sync_cursor = NULL")


def downgrade() -> None:
    bind = op.get_bind()
    if "mail_applications" in set(sa.inspect(bind).get_table_names()):
        op.drop_table("mail_applications")
