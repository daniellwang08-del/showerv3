"""Drop the Stripe subscription layer (user_subscriptions, users.stripe_customer_id).

Pricing moves to prepaid credits with a different payment provider, so the
subscription mirror and the Stripe customer id are no longer used.

Revision ID: 100_drop_stripe_subscriptions
Revises: 099_remove_retired_job_sites
Create Date: 2026-10-20
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "100_drop_stripe_subscriptions"
down_revision = "099_remove_retired_job_sites"
branch_labels = None
depends_on = None


def upgrade() -> None:
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


def downgrade() -> None:
    pass
