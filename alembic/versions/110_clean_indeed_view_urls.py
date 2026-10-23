"""Strip Indeed viewjob links down to ``?jk=``.

The Indeed plugin stored the API's final URL, which carries ``spa=1``. Indeed
answers that URL with the page's raw JSON, so opening the job showed a wall of
JSON instead of the posting.

Revision ID: 110_clean_indeed_view_urls
Revises: 109_open_signup
Create Date: 2026-10-22
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "110_clean_indeed_view_urls"
down_revision = "109_open_signup"
branch_labels = None
depends_on = None

_MATCH = r"^https?://(([a-z0-9-]+\.)?indeed\.com)/viewjob\?(.*&)?jk=([A-Za-z0-9]+)(&.*)?$"


def upgrade() -> None:
    bind = op.get_bind()
    for table in ("jobs", "job_extractions"):
        for column in ("source_url", "normalized_url"):
            bind.execute(
                sa.text(
                    f"UPDATE {table} SET {column} = regexp_replace({column}, :pattern, 'https://\\1/viewjob?jk=\\4', 'i') "
                    f"WHERE {column} ~* :pattern AND {column} !~* :clean"
                ),
                {"pattern": _MATCH, "clean": r"^https?://[^/]+/viewjob\?jk=[A-Za-z0-9]+$"},
            )


def downgrade() -> None:
    pass
