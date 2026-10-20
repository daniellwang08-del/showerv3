"""Grant notes and revocation audit on packages.

Revision ID: 102_package_admin_audit
Revises: 101_packages_credits_teams
Create Date: 2026-10-20
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "102_package_admin_audit"
down_revision = "101_packages_credits_teams"
branch_labels = None
depends_on = None

_COLUMNS = (
    ("note", sa.String(300)),
    ("revoked_at", sa.DateTime()),
    ("revoked_by_user_id", sa.String(36)),
    ("revoke_reason", sa.String(300)),
)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    existing = {c["name"] for c in inspector.get_columns("user_packages")}
    for name, type_ in _COLUMNS:
        if name not in existing:
            op.add_column("user_packages", sa.Column(name, type_, nullable=True))
    indexes = {i["name"] for i in inspector.get_indexes("user_packages")}
    if "ix_user_packages_status_created" not in indexes:
        op.create_index("ix_user_packages_status_created", "user_packages", ["status", "created_at"])


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    indexes = {i["name"] for i in inspector.get_indexes("user_packages")}
    if "ix_user_packages_status_created" in indexes:
        op.drop_index("ix_user_packages_status_created", table_name="user_packages")
    existing = {c["name"] for c in inspector.get_columns("user_packages")}
    for name, _type in reversed(_COLUMNS):
        if name in existing:
            op.drop_column("user_packages", name)
