"""Backfill the users.resume_template_design mirror from the library.

The résumé/cover-letter build engine renders from ``users.resume_template_design``
(a mirror of the active library resume). Users who have a library resume but a NULL
mirror - e.g. from a partial/older save - otherwise fall back to the default theme on
every tailored résumé. Copy the active (or most-recent) library resume's design into the
mirror so the build renders their real design.

Users with no library resume at all (legacy uploaded-template users) have no design to
recover and are intentionally left NULL - they render with the default theme until they
save a design in the builder.

Revision ID: 044_backfill_design_mirror
Revises: 043_resume_library
Create Date: 2026-07-05
"""

from alembic import op
import sqlalchemy as sa

revision = "044_backfill_design_mirror"
down_revision = "043_resume_library"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()

    users_tbl = sa.table(
        "users",
        sa.column("id", sa.String),
        sa.column("resume_template_design", sa.JSON),
        sa.column("active_resume_id", sa.String),
    )
    docs_tbl = sa.table(
        "resume_documents",
        sa.column("id", sa.String),
        sa.column("user_id", sa.String),
        sa.column("design", sa.JSON),
        sa.column("updated_at", sa.DateTime),
    )

    # Users whose mirror is empty but who own at least one library resume.
    users = bind.execute(
        sa.select(users_tbl.c.id, users_tbl.c.active_resume_id).where(
            users_tbl.c.resume_template_design.is_(None)
        )
    ).fetchall()

    backfilled = 0
    for u in users:
        design = None
        # Prefer the active resume's design.
        if u.active_resume_id:
            row = bind.execute(
                sa.select(docs_tbl.c.design).where(
                    docs_tbl.c.id == u.active_resume_id,
                    docs_tbl.c.user_id == u.id,
                )
            ).fetchone()
            if row and row.design:
                design = row.design
        # Otherwise the most-recently-updated library resume.
        if design is None:
            row = bind.execute(
                sa.select(docs_tbl.c.design)
                .where(docs_tbl.c.user_id == u.id, docs_tbl.c.design.isnot(None))
                .order_by(docs_tbl.c.updated_at.desc())
                .limit(1)
            ).fetchone()
            if row and row.design:
                design = row.design
        if design:
            bind.execute(
                users_tbl.update()
                .where(users_tbl.c.id == u.id)
                .values(resume_template_design=design)
            )
            backfilled += 1


def downgrade() -> None:
    # Non-destructive backfill; nothing to reverse (mirror is derived data).
    pass
