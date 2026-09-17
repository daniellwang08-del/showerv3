"""Stripe subscriptions: users.stripe_customer_id + user_subscriptions table.

Adds the billing layer's persistence: a reusable Stripe customer id on each
user (so Checkout never spawns duplicate customers) and a one-row-per-user
mirror of the current subscription kept in sync from Stripe webhooks.

Revision ID: 068_add_stripe_subscriptions
Revises: 067_match_result_provenance
Create Date: 2026-09-15
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "068_add_stripe_subscriptions"
down_revision = "067_match_result_provenance"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    # users.stripe_customer_id ------------------------------------------------
    if "users" in tables:
        user_cols = {c["name"] for c in inspector.get_columns("users")}
        if "stripe_customer_id" not in user_cols:
            op.add_column(
                "users",
                sa.Column("stripe_customer_id", sa.String(length=64), nullable=True),
            )
        user_indexes = {i["name"] for i in inspector.get_indexes("users")}
        if "ix_users_stripe_customer_id" not in user_indexes:
            op.create_index(
                "ix_users_stripe_customer_id",
                "users",
                ["stripe_customer_id"],
                unique=True,
            )

    # user_subscriptions ------------------------------------------------------
    if "user_subscriptions" not in tables:
        op.create_table(
            "user_subscriptions",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column(
                "user_id",
                sa.String(length=36),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("stripe_customer_id", sa.String(length=64), nullable=True),
            sa.Column("stripe_subscription_id", sa.String(length=64), nullable=True),
            sa.Column("plan", sa.String(length=20), nullable=True),
            sa.Column("price_id", sa.String(length=64), nullable=True),
            sa.Column(
                "status",
                sa.String(length=30),
                nullable=False,
                server_default="incomplete",
            ),
            sa.Column("current_period_end", sa.DateTime(), nullable=True),
            sa.Column(
                "cancel_at_period_end",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            ),
            sa.Column(
                "created_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.UniqueConstraint("user_id", name="uq_user_subscriptions_user_id"),
            sa.UniqueConstraint(
                "stripe_subscription_id",
                name="uq_user_subscriptions_stripe_subscription_id",
            ),
        )
        op.create_index(
            "ix_user_subscriptions_user_id",
            "user_subscriptions",
            ["user_id"],
        )
        op.create_index(
            "ix_user_subscriptions_stripe_customer_id",
            "user_subscriptions",
            ["stripe_customer_id"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "user_subscriptions" in tables:
        op.drop_table("user_subscriptions")

    if "users" in tables:
        user_indexes = {i["name"] for i in inspector.get_indexes("users")}
        if "ix_users_stripe_customer_id" in user_indexes:
            op.drop_index("ix_users_stripe_customer_id", table_name="users")
        user_cols = {c["name"] for c in inspector.get_columns("users")}
        if "stripe_customer_id" in user_cols:
            op.drop_column("users", "stripe_customer_id")
