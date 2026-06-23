"""Add eeo_preferences JSON column to users.

Stores the candidate's voluntary EEO / demographic answers (gender, race,
Hispanic/Latino, veteran, disability, work authorization, sponsorship) as a
single JSON object so deterministic application engines (Workday, etc.) can map
them directly instead of relying on hardcoded defaults. Nullable: existing rows
fall back to the engine's defaults until the user fills the section.

Revision ID: 039_eeo_preferences
Revises: 038_application_sessions
Create Date: 2026-06-19
"""

from alembic import op
import sqlalchemy as sa

revision = "039_eeo_preferences"
down_revision = "038_application_sessions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}
    if "eeo_preferences" not in columns:
        op.add_column("users", sa.Column("eeo_preferences", sa.JSON(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}
    if "eeo_preferences" in columns:
        op.drop_column("users", "eeo_preferences")
