"""Open signup: approve every account still waiting for an admin.

New accounts are approved on creation now. Accounts left "pending" by the old
approval flow are approved here, and access keys nobody used are revoked.
Blocked ("rejected") accounts stay blocked.

Revision ID: 109_open_signup
Revises: 108_calendar_seen
Create Date: 2026-10-22
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "109_open_signup"
down_revision = "108_calendar_seen"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE users SET approval_status = 'approved', approved_at = now() at time zone 'utc' "
            "WHERE approval_status = 'pending'"
        )
    )
    bind.execute(
        sa.text(
            "UPDATE signup_access_keys SET revoked_at = now() at time zone 'utc' "
            "WHERE used_at IS NULL AND revoked_at IS NULL"
        )
    )


def downgrade() -> None:
    pass
