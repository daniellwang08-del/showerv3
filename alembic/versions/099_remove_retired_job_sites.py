"""Drop connections to job sites removed from the integrations board.

Glassdoor kept hitting security checks, Remote.co listings sit behind a
paywall, Remotive and RemoteOK serve a 24-hour-delayed feed of the newest
handful of jobs, The Muse is stale, Arbeitnow is German-language only, and
Jooble, Reed and USAJOBS were never connected. Jobs already imported from
them stay in the pool.

Revision ID: 099_remove_retired_job_sites
Revises: 098_interview_event_ignored
Create Date: 2026-10-20
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "099_remove_retired_job_sites"
down_revision = "098_interview_event_ignored"
branch_labels = None
depends_on = None

RETIRED = (
    "arbeitnow",
    "glassdoor",
    "jooble",
    "reed",
    "remoteco",
    "remoteok",
    "remotive",
    "themuse",
    "usajobs",
    "linkedin",
    "indeed",
    "ziprecruiter",
    "wellfound",
    "otta",
    "handshake",
)


def upgrade() -> None:
    bind = op.get_bind()
    if "user_job_site_connections" not in set(sa.inspect(bind).get_table_names()):
        return
    bind.execute(
        sa.text("DELETE FROM user_job_site_connections WHERE plugin_slug = ANY(:slugs)"),
        {"slugs": list(RETIRED)},
    )


def downgrade() -> None:
    pass
