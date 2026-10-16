"""Read-only report links shared with invited people.

Revision ID: 096_report_shares
Revises: 095_mail_applications
Create Date: 2026-10-16
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "096_report_shares"
down_revision = "095_mail_applications"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if "report_shares" in set(sa.inspect(bind).get_table_names()):
        return
    op.create_table(
        "report_shares",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("token_enc", sa.Text(), nullable=False),
        sa.Column("include_notes", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("message", sa.String(500), nullable=True),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("last_viewed_at", sa.DateTime(), nullable=True),
        sa.Column("view_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("owner_id", "email", name="uq_report_share_owner_email"),
        sa.UniqueConstraint("token_hash", name="uq_report_share_token_hash"),
    )
    op.create_index("ix_report_shares_owner_id", "report_shares", ["owner_id"])
    op.create_index("ix_report_shares_email", "report_shares", ["email"])


def downgrade() -> None:
    bind = op.get_bind()
    if "report_shares" in set(sa.inspect(bind).get_table_names()):
        op.drop_table("report_shares")
