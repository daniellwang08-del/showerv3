"""Per-user job sources: registered ATS boards synced into the user pipeline.

Revision ID: 063_user_job_sources
Revises: 062_vector_match_engine
Create Date: 2026-09-02
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "063_user_job_sources"
down_revision = "062_vector_match_engine"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "user_job_sources" not in tables:
        op.create_table(
            "user_job_sources",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column(
                "user_id",
                sa.String(length=36),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("url", sa.Text(), nullable=False),
            sa.Column("name", sa.String(length=200), nullable=False),
            sa.Column("ats_type", sa.String(length=30), nullable=False),
            sa.Column("board_token", sa.String(length=200), nullable=False),
            sa.Column(
                "enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("true"),
            ),
            sa.Column("last_synced_at", sa.DateTime(), nullable=True),
            sa.Column("last_error", sa.Text(), nullable=True),
            sa.Column("last_listing_count", sa.Integer(), nullable=True),
            sa.Column("last_new_jobs", sa.Integer(), nullable=True),
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
            sa.UniqueConstraint(
                "user_id", "ats_type", "board_token", name="uq_user_job_source_board"
            ),
        )
        op.create_index("ix_user_job_sources_user_id", "user_job_sources", ["user_id"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "user_job_sources" in set(inspector.get_table_names()):
        op.drop_table("user_job_sources")
