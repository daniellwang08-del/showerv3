"""Add system_settings and blocked_domains for admin System Settings.

Revision ID: 049_admin_system_tables
Revises: 048_user_is_admin
Create Date: 2026-07-10
"""

from alembic import op
import sqlalchemy as sa

revision = "049_admin_system_tables"
down_revision = "048_user_is_admin"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "system_settings" not in tables:
        op.create_table(
            "system_settings",
            sa.Column("key", sa.String(100), primary_key=True),
            sa.Column("value", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_by_user_id", sa.String(36), nullable=True),
        )

    if "blocked_domains" not in tables:
        op.create_table(
            "blocked_domains",
            sa.Column("domain", sa.String(255), primary_key=True),
            sa.Column("reason", sa.Text(), nullable=False),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        )
        op.execute(
            sa.text(
                "INSERT INTO blocked_domains (domain, reason) VALUES "
                "('paycomonline.net', "
                "'Paycom ATS requires lengthy manual registration; auto-extraction not supported.') "
                "ON CONFLICT (domain) DO NOTHING"
            )
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "blocked_domains" in tables:
        op.drop_table("blocked_domains")
    if "system_settings" in tables:
        op.drop_table("system_settings")
