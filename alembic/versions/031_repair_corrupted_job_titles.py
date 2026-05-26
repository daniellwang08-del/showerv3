"""Repair persisted job titles corrupted as literal 'None' strings.

Revision ID: 031_repair_corrupted_job_titles
Revises: 030_resume_tailoring_prompt
Create Date: 2026-05-22
"""

from alembic import op
import sqlalchemy as sa

from app.services.job_field_utils import clean_optional_job_field, repair_stored_job_title

revision = "031_repair_corrupted_job_titles"
down_revision = "031_user_resume_template"
branch_labels = None
depends_on = None


def _repair_table(conn, table: str, description_column: str = "description") -> int:
    rows = conn.execute(
        sa.text(
            f"SELECT id, title, {description_column} AS description "
            f"FROM {table} WHERE title IS NOT NULL"
        )
    ).fetchall()
    repaired = 0
    for row in rows:
        row_id, title, description = row
        if clean_optional_job_field(title):
            continue
        fixed = repair_stored_job_title(current_title=title, description=description)
        conn.execute(
            sa.text(f"UPDATE {table} SET title = :title WHERE id = :id"),
            {"title": fixed, "id": row_id},
        )
        repaired += 1
    return repaired


def upgrade() -> None:
    conn = op.get_bind()
    ext_fixed = _repair_table(conn, "job_extractions")
    jobs_fixed = _repair_table(conn, "jobs")
    print(f"Repaired corrupted titles: job_extractions={ext_fixed}, jobs={jobs_fixed}")


def downgrade() -> None:
    # Data repair is not reversible.
    pass
