"""Unify valid_jobs + invalid_jobs into a single jobs table.

Replaces the split valid_jobs / invalid_jobs design with a single ``jobs``
table.  Per-user deduplication state moves from user_job_exclusions and
user_dismissed_duplicates into a new ``user_job_status`` junction table.

Changes
-------
1. Rename ``valid_jobs`` -> ``jobs``, add ``status`` column.
2. Create ``user_job_status`` table.
3. Migrate data from ``invalid_jobs``, ``user_job_exclusions``,
   ``user_dismissed_duplicates`` into the new schema.
4. Rename ``valid_job_id`` -> ``job_id`` in four FK tables.
5. Drop the three old tables and the ``is_active`` column.

Revision ID: 027_unify_jobs
Revises: 026_content_gen_status
Create Date: 2026-05-21
"""

from alembic import op
import sqlalchemy as sa

revision = "027_unify_jobs"
down_revision = "026_content_gen_status"
branch_labels = None
depends_on = None


def _table_exists(conn, table_name: str) -> bool:
    result = conn.execute(
        sa.text(
            "SELECT EXISTS ("
            "  SELECT 1 FROM information_schema.tables "
            "  WHERE table_schema = 'public' AND table_name = :t"
            ")"
        ),
        {"t": table_name},
    )
    return result.scalar()


def _column_exists(conn, table_name: str, column_name: str) -> bool:
    result = conn.execute(
        sa.text(
            "SELECT EXISTS ("
            "  SELECT 1 FROM information_schema.columns "
            "  WHERE table_schema = 'public' "
            "    AND table_name = :t AND column_name = :c"
            ")"
        ),
        {"t": table_name, "c": column_name},
    )
    return result.scalar()


def _constraint_exists(conn, constraint_name: str) -> bool:
    result = conn.execute(
        sa.text(
            "SELECT EXISTS ("
            "  SELECT 1 FROM information_schema.table_constraints "
            "  WHERE constraint_schema = 'public' AND constraint_name = :c"
            ")"
        ),
        {"c": constraint_name},
    )
    return result.scalar()


def _index_exists(conn, index_name: str) -> bool:
    result = conn.execute(
        sa.text(
            "SELECT EXISTS ("
            "  SELECT 1 FROM pg_indexes "
            "  WHERE schemaname = 'public' AND indexname = :i"
            ")"
        ),
        {"i": index_name},
    )
    return result.scalar()


def upgrade() -> None:
    conn = op.get_bind()

    has_valid_jobs = _table_exists(conn, "valid_jobs")
    has_jobs = _table_exists(conn, "jobs")

    # ── Step 1: Ensure jobs table exists (from valid_jobs rename) ─────────
    if has_valid_jobs and has_jobs:
        # A previous create_all created an empty "jobs" shell. Drop it so
        # we can rename valid_jobs (which holds the real data).
        conn.execute(sa.text("DROP TABLE IF EXISTS jobs CASCADE"))
        op.rename_table("valid_jobs", "jobs")
    elif has_valid_jobs and not has_jobs:
        op.rename_table("valid_jobs", "jobs")
    # else: jobs already exists and valid_jobs is gone — rename already done

    # Add status column if missing
    if not _column_exists(conn, "jobs", "status"):
        op.add_column(
            "jobs",
            sa.Column("status", sa.String(30), server_default="active", nullable=False),
        )
    if not _index_exists(conn, "ix_jobs_status"):
        op.create_index("ix_jobs_status", "jobs", ["status"])

    # ── Step 2: Create user_job_status table ─────────────────────────────
    if not _table_exists(conn, "user_job_status"):
        op.create_table(
            "user_job_status",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column(
                "user_id",
                sa.String(36),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "job_id",
                sa.String(36),
                sa.ForeignKey("jobs.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("status", sa.String(30), nullable=False),
            sa.Column(
                "duplicated_because_id",
                sa.String(36),
                sa.ForeignKey("jobs.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column("exclusion_type", sa.String(50), nullable=True),
            sa.Column("reason", sa.Text(), nullable=True),
            sa.Column("match_score_at_decision", sa.Float(), nullable=True),
            sa.Column(
                "created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
            ),
            sa.Column(
                "updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False
            ),
        )
    if not _constraint_exists(conn, "uq_user_job_status"):
        op.create_unique_constraint(
            "uq_user_job_status", "user_job_status", ["user_id", "job_id"]
        )
    if not _index_exists(conn, "ix_ujs_user_id"):
        op.create_index("ix_ujs_user_id", "user_job_status", ["user_id"])
    if not _index_exists(conn, "ix_ujs_job_id"):
        op.create_index("ix_ujs_job_id", "user_job_status", ["job_id"])
    if not _index_exists(conn, "ix_ujs_user_status"):
        op.create_index("ix_ujs_user_status", "user_job_status", ["user_id", "status"])

    # ── Step 3: Migrate user_job_exclusions -> user_job_status ───────────
    if _table_exists(conn, "user_job_exclusions"):
        op.execute(
            """
            INSERT INTO user_job_status
                (id, user_id, job_id, status, duplicated_because_id,
                 exclusion_type, reason, created_at, updated_at)
            SELECT
                id, user_id, valid_job_id, 'duplicated', excluded_because_job_id,
                exclusion_type, reason, created_at, created_at
            FROM user_job_exclusions
            ON CONFLICT DO NOTHING
            """
        )

    # ── Step 4: Migrate user_dismissed_duplicates ────────────────────────
    if _table_exists(conn, "user_dismissed_duplicates"):
        op.execute(
            """
            UPDATE user_job_status
            SET status = 'manual_hidden',
                updated_at = NOW()
            WHERE id IN (
                SELECT ujs.id
                FROM user_job_status ujs
                JOIN user_dismissed_duplicates udd
                  ON udd.user_id = ujs.user_id AND udd.entry_id = ujs.id
            )
            """
        )

    # ── Step 5: Migrate invalid_jobs rows into jobs ──────────────────────
    if _table_exists(conn, "invalid_jobs"):
        op.execute(
            """
            INSERT INTO jobs
                (id, source_url, normalized_url, domain, title, company,
                 location, description, posted_date, experience_level,
                 industry, raw_metadata, similarity_hash, status,
                 created_at, updated_at)
            SELECT
                ij.id, ij.source_url, ij.normalized_url, ij.domain,
                ij.title, ij.company, ij.location, ij.description,
                ij.posted_date, ij.experience_level, ij.industry,
                ij.raw_metadata, ij.similarity_hash,
                CASE
                    WHEN ij.duplication_reason ILIKE '%%blocked%%' THEN 'blocked'
                    ELSE 'active'
                END,
                ij.created_at, ij.updated_at
            FROM invalid_jobs ij
            WHERE ij.is_active = TRUE
              AND NOT EXISTS (
                  SELECT 1 FROM jobs j
                  WHERE j.normalized_url = ij.normalized_url
              )
            """
        )

    # ── Step 6: Rename valid_job_id -> job_id in four FK tables ──────────

    # --- job_match_results ---
    if _column_exists(conn, "job_match_results", "valid_job_id"):
        if _constraint_exists(conn, "uq_job_match_valid_job_user"):
            op.drop_constraint("uq_job_match_valid_job_user", "job_match_results", type_="unique")
        if _constraint_exists(conn, "job_match_results_valid_job_id_fkey"):
            op.drop_constraint("job_match_results_valid_job_id_fkey", "job_match_results", type_="foreignkey")
        op.alter_column("job_match_results", "valid_job_id", new_column_name="job_id")
    if not _constraint_exists(conn, "job_match_results_job_id_fkey"):
        op.create_foreign_key(
            "job_match_results_job_id_fkey", "job_match_results", "jobs",
            ["job_id"], ["id"], ondelete="CASCADE",
        )
    if not _constraint_exists(conn, "uq_job_match_job_user"):
        op.create_unique_constraint("uq_job_match_job_user", "job_match_results", ["job_id", "user_id"])

    # --- job_match_in_progress ---
    if _column_exists(conn, "job_match_in_progress", "valid_job_id"):
        if _constraint_exists(conn, "uq_job_match_progress_valid_job_user"):
            op.drop_constraint("uq_job_match_progress_valid_job_user", "job_match_in_progress", type_="unique")
        if _constraint_exists(conn, "job_match_in_progress_valid_job_id_fkey"):
            op.drop_constraint("job_match_in_progress_valid_job_id_fkey", "job_match_in_progress", type_="foreignkey")
        op.alter_column("job_match_in_progress", "valid_job_id", new_column_name="job_id")
    if not _constraint_exists(conn, "job_match_in_progress_job_id_fkey"):
        op.create_foreign_key(
            "job_match_in_progress_job_id_fkey", "job_match_in_progress", "jobs",
            ["job_id"], ["id"], ondelete="CASCADE",
        )
    if not _constraint_exists(conn, "uq_job_match_progress_job_user"):
        op.create_unique_constraint("uq_job_match_progress_job_user", "job_match_in_progress", ["job_id", "user_id"])

    # --- valid_job_user_applications ---
    if _column_exists(conn, "valid_job_user_applications", "valid_job_id"):
        if _constraint_exists(conn, "uq_valid_job_user_application"):
            op.drop_constraint("uq_valid_job_user_application", "valid_job_user_applications", type_="unique")
        if _index_exists(conn, "ix_valid_job_user_applications_user_valid"):
            op.drop_index("ix_valid_job_user_applications_user_valid", table_name="valid_job_user_applications")
        if _constraint_exists(conn, "valid_job_user_applications_valid_job_id_fkey"):
            op.drop_constraint("valid_job_user_applications_valid_job_id_fkey", "valid_job_user_applications", type_="foreignkey")
        op.alter_column("valid_job_user_applications", "valid_job_id", new_column_name="job_id")
    if not _constraint_exists(conn, "valid_job_user_applications_job_id_fkey"):
        op.create_foreign_key(
            "valid_job_user_applications_job_id_fkey", "valid_job_user_applications", "jobs",
            ["job_id"], ["id"], ondelete="CASCADE",
        )
    if not _constraint_exists(conn, "uq_job_user_application"):
        op.create_unique_constraint("uq_job_user_application", "valid_job_user_applications", ["user_id", "job_id"])
    if not _index_exists(conn, "ix_job_user_applications_user_job"):
        op.create_index("ix_job_user_applications_user_job", "valid_job_user_applications", ["user_id", "job_id"])

    # --- resume_build_results ---
    if _column_exists(conn, "resume_build_results", "valid_job_id"):
        if _constraint_exists(conn, "uq_resume_build_valid_job_user"):
            op.drop_constraint("uq_resume_build_valid_job_user", "resume_build_results", type_="unique")
        if _constraint_exists(conn, "resume_build_results_valid_job_id_fkey"):
            op.drop_constraint("resume_build_results_valid_job_id_fkey", "resume_build_results", type_="foreignkey")
        op.alter_column("resume_build_results", "valid_job_id", new_column_name="job_id")
    if not _constraint_exists(conn, "resume_build_results_job_id_fkey"):
        op.create_foreign_key(
            "resume_build_results_job_id_fkey", "resume_build_results", "jobs",
            ["job_id"], ["id"], ondelete="CASCADE",
        )
    if not _constraint_exists(conn, "uq_resume_build_job_user"):
        op.create_unique_constraint("uq_resume_build_job_user", "resume_build_results", ["job_id", "user_id"])

    # ── Step 7: Drop old tables ──────────────────────────────────────────
    if _table_exists(conn, "user_dismissed_duplicates"):
        op.drop_table("user_dismissed_duplicates")
    if _table_exists(conn, "user_job_exclusions"):
        op.drop_table("user_job_exclusions")
    if _table_exists(conn, "invalid_jobs"):
        op.drop_table("invalid_jobs")

    # ── Step 8: Drop is_active from jobs ─────────────────────────────────
    if _column_exists(conn, "jobs", "is_active"):
        op.drop_column("jobs", "is_active")


def downgrade() -> None:
    raise NotImplementedError(
        "Downgrade for 027_unify_jobs is not supported. "
        "Restore from backup if needed."
    )
