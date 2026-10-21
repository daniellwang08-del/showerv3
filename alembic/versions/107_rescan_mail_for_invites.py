"""Rescan the last two weeks of mail for calendar invites.

The prefilter used to drop invites whose subject and preview had no hiring
words (Teams and Outlook invites carry only the meeting title and a join
link), and the sync cursor had already moved past them. Moving each cursor
back lets the next sync look at them again; emails already stored are
skipped, so nothing is duplicated.

Revision ID: 107_rescan_mail_for_invites
Revises: 106_merge_duplicate_bookings
Create Date: 2026-10-21
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "107_rescan_mail_for_invites"
down_revision = "106_merge_duplicate_bookings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.get_bind().execute(
        sa.text(
            "update mail_connections set sync_cursor = sync_cursor - interval '14 days' "
            "where sync_cursor is not null"
        )
    )


def downgrade() -> None:
    pass
