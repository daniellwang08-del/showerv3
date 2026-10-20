"""Package store, credit balance and ledger, team spaces.

Every existing account gets the 50 signup credits new accounts receive, with
a matching ledger row, so balances and history agree from the start.

Revision ID: 101_packages_credits_teams
Revises: 100_drop_stripe_subscriptions
Create Date: 2026-10-20
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "101_packages_credits_teams"
down_revision = "100_drop_stripe_subscriptions"
branch_labels = None
depends_on = None

SIGNUP_CREDITS = 50


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    user_cols = {c["name"] for c in inspector.get_columns("users")}

    if "credit_balance" not in user_cols:
        op.add_column(
            "users",
            sa.Column("credit_balance", sa.Integer(), nullable=False, server_default="0"),
        )

    if "user_packages" not in tables:
        op.create_table(
            "user_packages",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("code", sa.String(20), nullable=False),
            sa.Column("kind", sa.String(16), nullable=False),
            sa.Column("credits", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("price_cents", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("owner_user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
            sa.Column("owner_email", sa.String(255), nullable=True),
            sa.Column("status", sa.String(16), nullable=False, server_default="held"),
            sa.Column("source", sa.String(16), nullable=False, server_default="admin_grant"),
            sa.Column(
                "gifted_from_user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
            ),
            sa.Column("granted_by_user_id", sa.String(36), nullable=True),
            sa.Column("redeemed_at", sa.DateTime(), nullable=True),
            sa.Column("redeemed_ref", sa.String(36), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        )
        op.create_index("ix_user_packages_owner_user_id", "user_packages", ["owner_user_id"])
        op.create_index("ix_user_packages_owner_email", "user_packages", ["owner_email"])
        op.create_index("ix_user_packages_gifted_from_user_id", "user_packages", ["gifted_from_user_id"])

    if "credit_ledger" not in tables:
        op.create_table(
            "credit_ledger",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("delta", sa.Integer(), nullable=False),
            sa.Column("balance_after", sa.Integer(), nullable=False),
            sa.Column("reason", sa.String(32), nullable=False),
            sa.Column("ref_id", sa.String(36), nullable=True),
            sa.Column("note", sa.String(300), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        )
        op.create_index("ix_credit_ledger_user_created", "credit_ledger", ["user_id", "created_at"])
        if "credit_balance" not in user_cols:
            bind.execute(
                sa.text(
                    "INSERT INTO credit_ledger (id, user_id, delta, balance_after, reason, note) "
                    "SELECT md5(random()::text || id)::uuid::text, id, :n, :n, 'signup_bonus', 'Welcome credits' "
                    "FROM users"
                ),
                {"n": SIGNUP_CREDITS},
            )
            bind.execute(sa.text("UPDATE users SET credit_balance = :n"), {"n": SIGNUP_CREDITS})

    if "team_spaces" not in tables:
        op.create_table(
            "team_spaces",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("public_id", sa.String(12), nullable=False),
            sa.Column("name", sa.String(80), nullable=False),
            sa.Column("owner_user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column(
                "package_id", sa.String(36), sa.ForeignKey("user_packages.id", ondelete="SET NULL"), nullable=True
            ),
            sa.Column("default_share_scope", sa.String(16), nullable=True),
            sa.Column("default_share_locked", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("public_id", name="uq_team_spaces_public_id"),
            sa.UniqueConstraint("package_id", name="uq_team_spaces_package_id"),
        )
        op.create_index("ix_team_spaces_owner_user_id", "team_spaces", ["owner_user_id"])

    if "team_members" not in tables:
        op.create_table(
            "team_members",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column(
                "team_space_id", sa.String(36), sa.ForeignKey("team_spaces.id", ondelete="CASCADE"), nullable=False
            ),
            sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("share_locked", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("joined_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("user_id", name="uq_team_members_user_id"),
        )
        op.create_index("ix_team_members_team_space_id", "team_members", ["team_space_id"])

    if "team_invites" not in tables:
        op.create_table(
            "team_invites",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column(
                "team_space_id", sa.String(36), sa.ForeignKey("team_spaces.id", ondelete="CASCADE"), nullable=False
            ),
            sa.Column("email", sa.String(255), nullable=False),
            sa.Column(
                "invited_by_user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
            ),
            sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("responded_at", sa.DateTime(), nullable=True),
        )
        op.create_index("ix_team_invites_team_space_id", "team_invites", ["team_space_id"])
        op.create_index("ix_team_invites_email", "team_invites", ["email"])


def downgrade() -> None:
    for table in ("team_invites", "team_members", "team_spaces", "credit_ledger", "user_packages"):
        op.execute(f"DROP TABLE IF EXISTS {table}")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS credit_balance")
