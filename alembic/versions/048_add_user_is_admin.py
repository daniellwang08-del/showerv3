"""Add users.is_admin and bootstrap existing users as admins.

Revision ID: 048_user_is_admin
Revises: 047_pumble_multiple
Create Date: 2026-07-10
"""

from alembic import op
import sqlalchemy as sa

revision = "048_user_is_admin"
down_revision = "047_pumble_multiple"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    if "is_admin" not in columns:
        op.add_column(
            "users",
            sa.Column("is_admin", sa.Boolean(), nullable=False, server_default=sa.false()),
        )

    # Bootstrap: every existing account becomes admin once.
    op.execute(sa.text("UPDATE users SET is_admin = true"))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}
    if "is_admin" in columns:
        op.drop_column("users", "is_admin")
