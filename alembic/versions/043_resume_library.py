"""Add the multi-resume library: resume_documents table + users.active_resume_id.

The Resume Builder used to hold exactly ONE design per user (users.resume_template_*).
This adds a library of saved resumes; the user's active resume is mirrored into the
existing users.resume_template_* columns so the extension, downloads and job-tailoring
keep working unchanged. Existing single designs are backfilled into one "My Resume" row.

Revision ID: 043_resume_library
Revises: 042_drop_uploaded_tpl_cols
Create Date: 2026-07-01
"""

import uuid

from alembic import op
import sqlalchemy as sa

revision = "043_resume_library"
down_revision = "042_drop_uploaded_tpl_cols"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "resume_documents" not in tables:
        op.create_table(
            "resume_documents",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column("user_id", sa.String(length=36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("name", sa.String(length=200), nullable=False, server_default="Untitled resume"),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="draft"),
            sa.Column("source", sa.String(length=20), nullable=False, server_default="manual"),
            sa.Column("design", sa.JSON(), nullable=True),
            sa.Column("job_title", sa.String(length=300), nullable=True),
            sa.Column("company", sa.String(length=300), nullable=True),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        )
        op.create_index("ix_resume_documents_user_id", "resume_documents", ["user_id"])

    user_cols = {c["name"] for c in inspector.get_columns("users")}
    if "active_resume_id" not in user_cols:
        op.add_column("users", sa.Column("active_resume_id", sa.String(length=36), nullable=True))

    # Backfill: turn each user's existing single design into one "My Resume" row and
    # mark it active. Idempotent-ish: only for users that have a design and no active id.
    users_tbl = sa.table(
        "users",
        sa.column("id", sa.String),
        sa.column("resume_template_design", sa.JSON),
        sa.column("active_resume_id", sa.String),
    )
    rows = bind.execute(
        sa.select(users_tbl.c.id, users_tbl.c.resume_template_design).where(
            users_tbl.c.resume_template_design.isnot(None),
            users_tbl.c.active_resume_id.is_(None),
        )
    ).fetchall()

    docs_tbl = sa.table(
        "resume_documents",
        sa.column("id", sa.String),
        sa.column("user_id", sa.String),
        sa.column("name", sa.String),
        sa.column("status", sa.String),
        sa.column("source", sa.String),
        sa.column("design", sa.JSON),
    )
    for row in rows:
        design = row.resume_template_design
        if not design:
            continue
        new_id = str(uuid.uuid4())
        bind.execute(
            docs_tbl.insert().values(
                id=new_id,
                user_id=row.id,
                name="My Resume",
                status="completed",
                source="manual",
                design=design,
            )
        )
        bind.execute(users_tbl.update().where(users_tbl.c.id == row.id).values(active_resume_id=new_id))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    user_cols = {c["name"] for c in inspector.get_columns("users")}
    if "active_resume_id" in user_cols:
        op.drop_column("users", "active_resume_id")
    tables = set(inspector.get_table_names())
    if "resume_documents" in tables:
        op.drop_index("ix_resume_documents_user_id", table_name="resume_documents")
        op.drop_table("resume_documents")
