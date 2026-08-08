"""Mark historical admin URL submits as FA (submitted_by_admin).

Revision ID: 059_admin_manual_added_from
Revises: 058_user_auto_prepare
Create Date: 2026-08-08
"""

from __future__ import annotations

from alembic import op


revision = "059_admin_manual_added_from"
down_revision = "058_user_auto_prepare"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Jobs stamped with submitted_data whose earliest pool link was an admin
    # (and not a non-admin within ~2 minutes of job create) were admin inventory
    # URL adds incorrectly labeled FM. Flag them as submitted_by_admin for FA.
    # Cast json → jsonb for ? / jsonb_set (jobs.raw_metadata is SQLAlchemy JSON).
    op.execute(
        """
        UPDATE jobs AS j
        SET raw_metadata = jsonb_set(
            COALESCE(j.raw_metadata::jsonb, '{}'::jsonb),
            '{submitted_by_admin}',
            'true'::jsonb,
            true
        )::json
        WHERE (j.raw_metadata::jsonb) ? 'submitted_data'
          AND COALESCE(j.raw_metadata::jsonb->>'submitted_by_admin', 'false') <> 'true'
          AND EXISTS (
            SELECT 1
            FROM user_job_status AS ujs
            JOIN users AS u ON u.id = ujs.user_id
            WHERE ujs.job_id = j.id
              AND COALESCE(u.is_admin, false) IS TRUE
              AND ABS(EXTRACT(EPOCH FROM (ujs.created_at - j.created_at))) < 120
          )
          AND NOT EXISTS (
            SELECT 1
            FROM user_job_status AS ujs2
            JOIN users AS u2 ON u2.id = ujs2.user_id
            WHERE ujs2.job_id = j.id
              AND COALESCE(u2.is_admin, false) IS FALSE
              AND ABS(EXTRACT(EPOCH FROM (ujs2.created_at - j.created_at))) < 120
          )
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE jobs
        SET raw_metadata = ((raw_metadata::jsonb) - 'submitted_by_admin')::json
        WHERE (raw_metadata::jsonb) ? 'submitted_by_admin'
          AND (raw_metadata::jsonb) ? 'submitted_data'
        """
    )
