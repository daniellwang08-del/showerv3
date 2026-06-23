"""Add address JSON column to users.

Stores the candidate's mailing address (line1, line2, city, state, postal_code,
country) as a single JSON object so deterministic application engines (Workday,
etc.) can map the required Address / City / State / Postal Code fields directly.
Nullable: existing rows have no address until the user fills the section.

Revision ID: 040_address
Revises: 039_eeo_preferences
Create Date: 2026-06-20
"""

from alembic import op
import sqlalchemy as sa

revision = "040_address"
down_revision = "039_eeo_preferences"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}
    if "address" not in columns:
        op.add_column("users", sa.Column("address", sa.JSON(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}
    if "address" in columns:
        op.drop_column("users", "address")
