"""Issue reports from users, with screenshot and file attachments.

Revision ID: 105_issue_reports
Revises: 104_user_profile_photo
Create Date: 2026-10-21
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "105_issue_reports"
down_revision = "104_user_profile_photo"
branch_labels = None
depends_on = None


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "issue_reports" not in tables:
        op.create_table(
            "issue_reports",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("number", sa.Integer(), sa.Identity(), nullable=False, unique=True),
            sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("category", sa.String(24), nullable=False, server_default="bug"),
            sa.Column("title", sa.String(160), nullable=False),
            sa.Column("description", sa.Text(), nullable=False),
            sa.Column("status", sa.String(16), nullable=False, server_default="open"),
            sa.Column("source", sa.String(16), nullable=False, server_default="extension"),
            sa.Column("page_url", sa.String(2048), nullable=True),
            sa.Column("page_title", sa.String(300), nullable=True),
            sa.Column("context", sa.JSON(), nullable=True),
            sa.Column("admin_note", sa.Text(), nullable=True),
            sa.Column("status_changed_at", sa.DateTime(), nullable=True),
            sa.Column(
                "status_changed_by_user_id",
                sa.String(36),
                sa.ForeignKey("users.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        )
        op.create_index("ix_issue_reports_user_id", "issue_reports", ["user_id"])
        op.create_index("ix_issue_reports_status_created", "issue_reports", ["status", "created_at"])
    if "issue_report_attachments" not in tables:
        op.create_table(
            "issue_report_attachments",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column(
                "report_id",
                sa.String(36),
                sa.ForeignKey("issue_reports.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("kind", sa.String(8), nullable=False),
            sa.Column("filename", sa.String(255), nullable=False),
            sa.Column("content_type", sa.String(120), nullable=False),
            sa.Column("byte_size", sa.Integer(), nullable=False),
            sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("data", sa.LargeBinary(), nullable=False),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        )
        op.create_index("ix_issue_report_attachments_report_id", "issue_report_attachments", ["report_id"])


def downgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "issue_report_attachments" in tables:
        op.drop_table("issue_report_attachments")
    if "issue_reports" in tables:
        op.drop_table("issue_reports")
