"""Add resume_template_design JSON column to users.

Stores the visual resume builder design config (theme, typography, colors, layout,
section order/visibility). When present, the user's working resume template is
generated from this design instead of an uploaded .docx. Nullable: existing rows
keep their uploaded template until they save a design.

Revision ID: 041_resume_template_design
Revises: 040_address
Create Date: 2026-06-25
"""

from alembic import op
import sqlalchemy as sa

revision = "041_resume_template_design"
down_revision = "040_address"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}
    if "resume_template_design" not in columns:
        op.add_column("users", sa.Column("resume_template_design", sa.JSON(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {c["name"] for c in inspector.get_columns("users")}
    if "resume_template_design" in columns:
        op.drop_column("users", "resume_template_design")
