"""New accounts score jobs automatically: users.auto_prepare_match defaults to true.

Only the column default changes; existing users keep whatever they chose.

Revision ID: 069_auto_score_default_on
Revises: 068_add_stripe_subscriptions
Create Date: 2026-10-03
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "069_auto_score_default_on"
down_revision = "068_add_stripe_subscriptions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("users", "auto_prepare_match", server_default=sa.text("true"))


def downgrade() -> None:
    op.alter_column("users", "auto_prepare_match", server_default=sa.text("false"))
