"""Legacy revision alias — resume template columns (superseded by 032).

Some databases were stamped with revision id ``031_user_resume_template`` before
``031_repair_corrupted_job_titles`` and ``032_user_resume_template`` were split out.
This no-op migration keeps Alembic able to locate that stamp; schema changes live in
032_add_user_resume_template.py (idempotent column checks).

Revision ID: 031_user_resume_template
Revises: 030_resume_tailoring_prompt
Create Date: 2026-05-22
"""

from alembic import op

revision = "031_user_resume_template"
down_revision = "030_resume_tailoring_prompt"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Legacy stamp only — columns are applied in 032_user_resume_template.
    pass


def downgrade() -> None:
    pass
