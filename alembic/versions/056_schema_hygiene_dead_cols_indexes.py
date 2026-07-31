"""Drop dead schema objects; add list/filter indexes; FK active_resume_id.

Phase 1–3 database hygiene from the verified design audit:
  - Drop unused api_pattern_registry table
  - Drop dead columns: jobs.similarity_hash, jobs.click_count,
    job_extractions.raw_html / application_deadline / posted_date,
    scrape_runs.requests_made
  - Add indexes for scraped_jobs.scraped_at, jobs.work_mode,
    jobs.sheet_posted_at / pumble_posted_at (partial)
  - FK users.active_resume_id → resume_documents.id
  - Drop redundant ix_users_email / ix_users_is_active when unique/index
    already covers the column

Revision ID: 056_schema_hygiene
Revises: 055_user_llm_model
Create Date: 2026-07-28
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "056_schema_hygiene"
down_revision = "055_user_llm_model"
branch_labels = None
depends_on = None


def _table_names(inspector) -> set[str]:
    return set(inspector.get_table_names())


def _columns(inspector, table: str) -> set[str]:
    if table not in _table_names(inspector):
        return set()
    return {c["name"] for c in inspector.get_columns(table)}


def _indexes(inspector, table: str) -> set[str]:
    if table not in _table_names(inspector):
        return set()
    return {i["name"] for i in inspector.get_indexes(table) if i.get("name")}


def _fks(inspector, table: str) -> set[str]:
    if table not in _table_names(inspector):
        return set()
    return {fk["name"] for fk in inspector.get_foreign_keys(table) if fk.get("name")}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = _table_names(inspector)

    # --- Dead table ---
    if "api_pattern_registry" in tables:
        op.drop_table("api_pattern_registry")

    # --- jobs dead columns + indexes ---
    job_cols = _columns(inspector, "jobs")
    job_idxs = _indexes(inspector, "jobs")
    if "similarity_hash" in job_cols:
        if "ix_jobs_similarity_hash" in job_idxs:
            op.drop_index("ix_jobs_similarity_hash", table_name="jobs")
        op.drop_column("jobs", "similarity_hash")
    if "click_count" in job_cols:
        op.drop_column("jobs", "click_count")

    # Refresh after drops
    inspector = sa.inspect(bind)
    job_idxs = _indexes(inspector, "jobs")
    if "ix_jobs_work_mode" not in job_idxs:
        op.create_index("ix_jobs_work_mode", "jobs", ["work_mode"])
    if "ix_jobs_sheet_posted_at_not_null" not in job_idxs:
        op.create_index(
            "ix_jobs_sheet_posted_at_not_null",
            "jobs",
            ["sheet_posted_at"],
            postgresql_where=sa.text("sheet_posted_at IS NOT NULL"),
        )
    if "ix_jobs_pumble_posted_at_not_null" not in job_idxs:
        op.create_index(
            "ix_jobs_pumble_posted_at_not_null",
            "jobs",
            ["pumble_posted_at"],
            postgresql_where=sa.text("pumble_posted_at IS NOT NULL"),
        )

    # --- job_extractions dead columns ---
    ext_cols = _columns(inspector, "job_extractions")
    for col in ("raw_html", "application_deadline", "posted_date"):
        if col in ext_cols:
            op.drop_column("job_extractions", col)

    # --- scrape_runs.requests_made ---
    run_cols = _columns(inspector, "scrape_runs")
    if "requests_made" in run_cols:
        op.drop_column("scrape_runs", "requests_made")

    # --- scraped_jobs.scraped_at index (default list ORDER BY) ---
    inspector = sa.inspect(bind)
    scraped_idxs = _indexes(inspector, "scraped_jobs")
    if "scraped_jobs" in tables and "ix_scraped_jobs_scraped_at" not in scraped_idxs:
        op.create_index("ix_scraped_jobs_scraped_at", "scraped_jobs", ["scraped_at"])

    # --- users: clear dangling active_resume_id, add FK, drop redundant email index ---
    inspector = sa.inspect(bind)
    user_cols = _columns(inspector, "users")
    user_idxs = _indexes(inspector, "users")
    user_fks = _fks(inspector, "users")
    if "active_resume_id" in user_cols and "resume_documents" in tables:
        op.execute(
            sa.text(
                """
                UPDATE users AS u
                SET active_resume_id = NULL
                WHERE u.active_resume_id IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM resume_documents d
                    WHERE d.id = u.active_resume_id AND d.user_id = u.id
                  )
                """
            )
        )
        if "fk_users_active_resume_id" not in user_fks:
            op.create_foreign_key(
                "fk_users_active_resume_id",
                "users",
                "resume_documents",
                ["active_resume_id"],
                ["id"],
                ondelete="SET NULL",
            )

    # email already has unique=True; drop duplicate named index if present
    if "ix_users_email" in user_idxs:
        # Only drop when a unique constraint/index on email also exists
        email_indexes = [
            i for i in sa.inspect(bind).get_indexes("users")
            if i.get("column_names") == ["email"]
        ]
        if len(email_indexes) > 1:
            op.drop_index("ix_users_email", table_name="users")


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = _table_names(inspector)

    user_fks = _fks(inspector, "users")
    if "fk_users_active_resume_id" in user_fks:
        op.drop_constraint("fk_users_active_resume_id", "users", type_="foreignkey")

    scraped_idxs = _indexes(inspector, "scraped_jobs")
    if "ix_scraped_jobs_scraped_at" in scraped_idxs:
        op.drop_index("ix_scraped_jobs_scraped_at", table_name="scraped_jobs")

    job_idxs = _indexes(inspector, "jobs")
    for name in (
        "ix_jobs_pumble_posted_at_not_null",
        "ix_jobs_sheet_posted_at_not_null",
        "ix_jobs_work_mode",
    ):
        if name in job_idxs:
            op.drop_index(name, table_name="jobs")

    run_cols = _columns(inspector, "scrape_runs")
    if "scrape_runs" in tables and "requests_made" not in run_cols:
        op.add_column("scrape_runs", sa.Column("requests_made", sa.Integer(), server_default="0"))

    ext_cols = _columns(inspector, "job_extractions")
    if "job_extractions" in tables:
        if "posted_date" not in ext_cols:
            op.add_column("job_extractions", sa.Column("posted_date", sa.DateTime(), nullable=True))
        if "application_deadline" not in ext_cols:
            op.add_column("job_extractions", sa.Column("application_deadline", sa.DateTime(), nullable=True))
        if "raw_html" not in ext_cols:
            op.add_column("job_extractions", sa.Column("raw_html", sa.Text(), nullable=True))

    job_cols = _columns(inspector, "jobs")
    if "jobs" in tables:
        if "click_count" not in job_cols:
            op.add_column(
                "jobs",
                sa.Column("click_count", sa.Integer(), nullable=False, server_default="0"),
            )
        if "similarity_hash" not in job_cols:
            op.add_column("jobs", sa.Column("similarity_hash", sa.String(length=64), nullable=True))
            op.create_index("ix_jobs_similarity_hash", "jobs", ["similarity_hash"])

    if "api_pattern_registry" not in tables:
        op.create_table(
            "api_pattern_registry",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column("domain_pattern", sa.String(length=255), nullable=False, unique=True),
            sa.Column("api_endpoint_template", sa.Text(), nullable=True),
            sa.Column("json_ld_selector", sa.String(length=255), nullable=True),
            sa.Column("extraction_hints", sa.JSON(), nullable=True),
            sa.Column("priority", sa.Float(), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=True),
            sa.Column("success_rate", sa.Float(), nullable=True),
            sa.Column("last_success_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
            sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        )
