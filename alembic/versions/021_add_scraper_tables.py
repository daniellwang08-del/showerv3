"""Add scraped_jobs, scrape_runs, scrape_checkpoints tables.

Revision ID: 021
Revises: 020_rename_selected_tabs_to_tab_groups
Create Date: 2026-05-18
"""
from alembic import op
import sqlalchemy as sa

revision = "021_add_scraper_tables"
down_revision = "020_tab_groups"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "scrape_runs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("spider_name", sa.String(128), nullable=False, index=True),
        sa.Column("started_at", sa.DateTime),
        sa.Column("finished_at", sa.DateTime),
        sa.Column("items_scraped", sa.Integer, default=0),
        sa.Column("items_new", sa.Integer, default=0),
        sa.Column("items_updated", sa.Integer, default=0),
        sa.Column("requests_made", sa.Integer, default=0),
        sa.Column("errors", sa.Integer, default=0),
        sa.Column("status", sa.String(32), default="running"),
    )

    op.create_table(
        "scrape_checkpoints",
        sa.Column("spider_name", sa.String(128), primary_key=True),
        sa.Column("marker_job_ids", sa.Text, nullable=False),
        sa.Column("updated_at", sa.DateTime),
    )

    op.create_table(
        "scraped_jobs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("source", sa.String(64), nullable=False),
        sa.Column("source_job_id", sa.String(256), nullable=False),
        sa.Column("url", sa.String(2048), nullable=False),
        sa.Column("origin_url", sa.String(2048)),
        sa.Column("title", sa.String(512), nullable=False),
        sa.Column("company_name", sa.String(512)),
        sa.Column("location", sa.String(512)),
        sa.Column("is_remote", sa.Boolean, default=False),
        sa.Column("salary_raw", sa.String(256)),
        sa.Column("salary_min_cents", sa.Integer),
        sa.Column("salary_max_cents", sa.Integer),
        sa.Column("salary_currency", sa.String(8), default="USD"),
        sa.Column("salary_period", sa.String(32)),
        sa.Column("description", sa.Text),
        sa.Column("job_type", sa.String(64)),
        sa.Column("experience_level", sa.String(64)),
        sa.Column("tags", sa.Text),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("posted_at", sa.DateTime),
        sa.Column("scraped_at", sa.DateTime),
        sa.Column("updated_at", sa.DateTime),
        sa.Column(
            "scrape_run_id",
            sa.String(36),
            sa.ForeignKey("scrape_runs.id"),
        ),
        sa.UniqueConstraint("source", "source_job_id", name="uq_scraped_source_job"),
    )

    op.create_index("ix_scraped_jobs_source", "scraped_jobs", ["source"])
    op.create_index("ix_scraped_jobs_content_hash", "scraped_jobs", ["content_hash"])
    op.create_index("ix_scraped_source_posted", "scraped_jobs", ["source", "posted_at"])


def downgrade() -> None:
    op.drop_table("scraped_jobs")
    op.drop_table("scrape_checkpoints")
    op.drop_table("scrape_runs")
