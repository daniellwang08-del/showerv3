"""Read-path indexes for the dashboard and drop indexes that duplicate others.

* ``jobs`` keyset order for the visible pool (status <> 'blocked').
* ``job_match_results (user_id, job_id) INCLUDE (overall_score)`` so score
  filters and sorts are index-only.
* Trigram GIN on ``jobs.title`` / ``jobs.company`` for ``ILIKE '%term%'`` search.
* ``scrape_runs (started_at)`` for the latest-run lookups the runner polls.
* Dropped: indexes whose columns are a prefix of a unique or composite index
  on the same table. They cost a write on every insert and are never chosen.

All index DDL runs CONCURRENTLY so the live stack keeps serving.

Revision ID: 071_perf_indexes
Revises: 070_resume_document_cover_letter
Create Date: 2026-10-03
"""

from __future__ import annotations

from alembic import op


revision = "071_perf_indexes"
down_revision = "070_resume_document_cover_letter"
branch_labels = None
depends_on = None


_CREATE = (
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_jobs_visible_created "
    "ON jobs (created_at DESC, id DESC) WHERE status <> 'blocked'",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_jmr_user_job_score "
    "ON job_match_results (user_id, job_id) INCLUDE (overall_score)",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_jobs_title_trgm "
    "ON jobs USING gin (title gin_trgm_ops)",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_jobs_company_trgm "
    "ON jobs USING gin (company gin_trgm_ops)",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_scrape_runs_started_at "
    "ON scrape_runs (started_at DESC)",
)

# (index, table, columns) so downgrade can rebuild them.
_REDUNDANT = (
    ("ix_job_match_valid_job_user", "job_match_results", "job_id, user_id"),
    ("ix_job_match_results_valid_job_id", "job_match_results", "job_id"),
    ("ix_job_match_in_progress_valid_user", "job_match_in_progress", "job_id, user_id"),
    ("ix_ujs_user_id", "user_job_status", "user_id"),
    ("ix_job_extractions_domain", "job_extractions", "domain"),
    ("ix_scraped_jobs_source", "scraped_jobs", "source"),
    ("ix_system_log_events_level", "system_log_events", "level"),
)


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    with op.get_context().autocommit_block():
        for ddl in _CREATE:
            op.execute(ddl)
        for name, _table, _cols in _REDUNDANT:
            op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {name}")


def downgrade() -> None:
    with op.get_context().autocommit_block():
        for name, table, cols in _REDUNDANT:
            op.execute(f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {name} ON {table} ({cols})")
        for name in (
            "ix_jobs_visible_created",
            "ix_jmr_user_job_score",
            "ix_jobs_title_trgm",
            "ix_jobs_company_trgm",
            "ix_scrape_runs_started_at",
        ):
            op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {name}")
