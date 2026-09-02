"""Per-user country preferences for global job-location filtering.

- country_preferences: JSON list of ISO 3166-1 alpha-2 codes. Empty list means
  no location filtering (worldwide).
- country_preferences_source: 'unset' | 'auto' (resume parse) | 'manual'
  (preferences page). Resume auto-detect never overwrites 'manual'.

Existing users are backfilled to ["US"] so the historical US-only filtering
behavior is preserved until they change it (or a resume re-parse updates it).

Revision ID: 061_add_country_preferences
Revises: 060_manual_submit_pipeline
Create Date: 2026-09-01
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "061_add_country_preferences"
down_revision = "060_manual_submit_pipeline"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    if "country_preferences" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "country_preferences",
                sa.JSON(),
                nullable=False,
                server_default=sa.text("'[]'"),
            ),
        )
        # Preserve current behavior for existing accounts: US-only filtering.
        op.execute("UPDATE users SET country_preferences = '[\"US\"]'")

    if "country_preferences_source" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "country_preferences_source",
                sa.String(length=20),
                nullable=False,
                server_default="unset",
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    if "country_preferences_source" in columns:
        op.drop_column("users", "country_preferences_source")
    if "country_preferences" in columns:
        op.drop_column("users", "country_preferences")
