"""Remember calendar events the interview sync already looked at.

Calendar sync rereads a window of events on every run. Events already read
are kept here (event id -> version) so unrelated events are not sent to the
model again, and steps the user deleted are not added back, until they change.

Revision ID: 108_calendar_seen
Revises: 107_rescan_mail_for_invites
Create Date: 2026-10-21
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "108_calendar_seen"
down_revision = "107_rescan_mail_for_invites"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("mail_connections", sa.Column("calendar_seen", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("mail_connections", "calendar_seen")
