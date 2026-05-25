"""Add content_generation_status to resume_build_results for Phase B tracking."""

from alembic import op
import sqlalchemy as sa

revision = "026_content_gen_status"
down_revision = "025_dedup_recycle_days"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "resume_build_results",
        sa.Column(
            "content_generation_status",
            sa.String(20),
            nullable=False,
            server_default="pending",
        ),
    )
    op.add_column(
        "resume_build_results",
        sa.Column("content_generation_error", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("resume_build_results", "content_generation_error")
    op.drop_column("resume_build_results", "content_generation_status")
