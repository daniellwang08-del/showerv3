"""Per-user dedup rule prefs; restore location_unknown exclusions.

Adds applied-company / score-comparison preference columns on users and
clears historical location_unknown hides (unknown locations are treated as US).

Revision ID: 057_user_dedup_rule_prefs
Revises: 056_schema_hygiene
Create Date: 2026-08-07
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "057_user_dedup_rule_prefs"
down_revision = "056_schema_hygiene"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    if "dedup_applied_company_mode" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "dedup_applied_company_mode",
                sa.String(20),
                nullable=False,
                server_default="default",
            ),
        )
    if "dedup_applied_company_enabled" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "dedup_applied_company_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )
    if "dedup_score_comparison_mode" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "dedup_score_comparison_mode",
                sa.String(20),
                nullable=False,
                server_default="default",
            ),
        )
    if "dedup_score_comparison_enabled" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "dedup_score_comparison_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )

    # One-shot: unknown locations are treated as US, restore prior hides.
    tables = set(inspector.get_table_names())
    if "user_job_status" in tables:
        op.execute(
            sa.text(
                """
                UPDATE user_job_status
                SET status = 'active',
                    exclusion_type = NULL,
                    duplicated_because_id = NULL,
                    reason = NULL,
                    updated_at = timezone('UTC', now())
                WHERE status = 'duplicated'
                  AND exclusion_type = 'location_unknown'
                """
            )
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}

    for col in (
        "dedup_score_comparison_enabled",
        "dedup_score_comparison_mode",
        "dedup_applied_company_enabled",
        "dedup_applied_company_mode",
    ):
        if col in columns:
            op.drop_column("users", col)
