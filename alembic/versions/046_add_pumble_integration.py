"""Add pumble_config table and pumble_posted_at column on jobs.

Revision ID: 046_pumble_integration
Revises: 045_match_prefs_work_mode
Create Date: 2026-07-09
"""

from alembic import op
import sqlalchemy as sa

revision = "046_pumble_integration"
down_revision = "045_match_prefs_work_mode"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "pumble_config" not in tables:
        op.create_table(
            "pumble_config",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column(
                "user_id",
                sa.String(36),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
                unique=True,
            ),
            sa.Column("api_key_encrypted", sa.Text(), nullable=False),
            sa.Column("workspace_id", sa.String(255), nullable=True),
            sa.Column("channel_id", sa.String(255), nullable=False),
            sa.Column("channel_name", sa.String(255), nullable=False),
            sa.Column("parent_message_id", sa.String(255), nullable=True),
            sa.Column("parent_posted_date", sa.Date(), nullable=True),
            sa.Column("auto_post_threshold", sa.Integer(), nullable=False, server_default="75"),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        )
        op.create_index("ix_pumble_config_user_id", "pumble_config", ["user_id"])

    job_columns = {c["name"] for c in inspector.get_columns("jobs")}
    if "pumble_posted_at" not in job_columns:
        op.add_column("jobs", sa.Column("pumble_posted_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    job_columns = {c["name"] for c in inspector.get_columns("jobs")}
    if "pumble_posted_at" in job_columns:
        op.drop_column("jobs", "pumble_posted_at")

    tables = set(inspector.get_table_names())
    if "pumble_config" in tables:
        op.drop_index("ix_pumble_config_user_id", table_name="pumble_config")
        op.drop_table("pumble_config")
