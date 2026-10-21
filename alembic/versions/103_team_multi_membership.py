"""People can belong to several team spaces: unique per (space, user), not per user.

Revision ID: 103_team_multi_membership
Revises: 102_package_admin_audit
Create Date: 2026-10-21
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "103_team_multi_membership"
down_revision = "102_package_admin_audit"
branch_labels = None
depends_on = None


def _uniques(inspector) -> set[str]:
    return {u["name"] for u in inspector.get_unique_constraints("team_members")}


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    uniques = _uniques(inspector)
    if "uq_team_members_user_id" in uniques:
        op.drop_constraint("uq_team_members_user_id", "team_members", type_="unique")
    if "uq_team_members_space_user" not in uniques:
        op.create_unique_constraint("uq_team_members_space_user", "team_members", ["team_space_id", "user_id"])
    if "ix_team_members_user_id" not in {i["name"] for i in inspector.get_indexes("team_members")}:
        op.create_index("ix_team_members_user_id", "team_members", ["user_id"])


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "ix_team_members_user_id" in {i["name"] for i in inspector.get_indexes("team_members")}:
        op.drop_index("ix_team_members_user_id", table_name="team_members")
    uniques = _uniques(inspector)
    if "uq_team_members_space_user" in uniques:
        op.drop_constraint("uq_team_members_space_user", "team_members", type_="unique")
    # Keeps each person's earliest membership so the one-team rule can return.
    op.execute(
        """
        DELETE FROM team_members t USING team_members k
        WHERE t.user_id = k.user_id AND (t.joined_at, t.id) > (k.joined_at, k.id)
        """
    )
    if "uq_team_members_user_id" not in uniques:
        op.create_unique_constraint("uq_team_members_user_id", "team_members", ["user_id"])
