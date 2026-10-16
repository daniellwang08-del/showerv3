"""Report shares go to NAO accounts instead of public links.

Revision ID: 097_report_shares_accounts
Revises: 096_report_shares
Create Date: 2026-10-16
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "097_report_shares_accounts"
down_revision = "096_report_shares"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if "report_shares" not in set(sa.inspect(bind).get_table_names()):
        return
    columns = {c["name"] for c in sa.inspect(bind).get_columns("report_shares")}
    if "viewer_id" in columns:
        return

    op.add_column(
        "report_shares",
        sa.Column("viewer_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
    )
    # Link existing shares to the account with that email; shares to people without an account are dropped.
    op.execute(
        "UPDATE report_shares s SET viewer_id = u.id FROM users u "
        "WHERE lower(u.email) = s.email AND u.id <> s.owner_id"
    )
    op.execute("DELETE FROM report_shares WHERE viewer_id IS NULL")
    op.alter_column("report_shares", "viewer_id", nullable=False)
    op.create_index("ix_report_shares_viewer_id", "report_shares", ["viewer_id"])
    op.drop_constraint("uq_report_share_owner_email", "report_shares", type_="unique")
    op.create_unique_constraint("uq_report_share_owner_viewer", "report_shares", ["owner_id", "viewer_id"])
    op.drop_index("ix_report_shares_email", table_name="report_shares")
    op.drop_constraint("uq_report_share_token_hash", "report_shares", type_="unique")
    op.drop_column("report_shares", "token_hash")
    op.drop_column("report_shares", "token_enc")


def downgrade() -> None:
    bind = op.get_bind()
    if "report_shares" in set(sa.inspect(bind).get_table_names()):
        op.drop_table("report_shares")
