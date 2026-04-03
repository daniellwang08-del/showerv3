"""Add 'extracted' value to ExtractionStatus enum.

The extraction pipeline now sets status to 'extracted' after caching plain
text in Redis, before the analysis worker structures the content and sets
'completed'.

Revision ID: 016_add_extracted_status
Revises: 015_cleanup_columns
Create Date: 2026-04-03
"""

from typing import Sequence, Union

from alembic import op

revision: str = "016_add_extracted_status"
down_revision: str | None = "015_cleanup_columns"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # PostgreSQL ALTER TYPE ... ADD VALUE cannot run inside a transaction.
    # Commit the Alembic transaction first, then add the value.
    op.execute("COMMIT")
    op.execute("ALTER TYPE extractionstatus ADD VALUE IF NOT EXISTS 'EXTRACTED' BEFORE 'COMPLETED'")


def downgrade() -> None:
    # PostgreSQL does not support removing enum values.
    pass
