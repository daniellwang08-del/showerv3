"""Vector (non-LLM) match engine: encodings + shadow-mode comparisons.

- job_encodings: once-per-job embedding vectors (float32 bytes) + deterministic
  signals (skills, years, degree, clearance). No pgvector extension needed.
- user_encodings: once-per-profile embeddings, refreshed on profile change
  (guarded by profile_hash).
- match_engine_comparisons: shadow-mode LLM-vs-vector score pairs used to
  calibrate the vector scorer before cutover.

Revision ID: 062_vector_match_engine
Revises: 061_add_country_preferences
Create Date: 2026-09-02
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "062_vector_match_engine"
down_revision = "061_add_country_preferences"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "job_encodings" not in tables:
        op.create_table(
            "job_encodings",
            sa.Column(
                "job_id",
                sa.String(length=36),
                sa.ForeignKey("jobs.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column("model_version", sa.String(length=200), nullable=False),
            sa.Column("title_vec", sa.LargeBinary(), nullable=True),
            sa.Column("content_vec", sa.LargeBinary(), nullable=True),
            sa.Column(
                "skills", sa.JSON(), nullable=False, server_default=sa.text("'{}'")
            ),
            sa.Column("years_required", sa.Integer(), nullable=True),
            sa.Column("degree_required", sa.Boolean(), nullable=True),
            sa.Column(
                "requires_security_clearance",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            ),
            sa.Column(
                "encoded_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
            ),
        )

    if "user_encodings" not in tables:
        op.create_table(
            "user_encodings",
            sa.Column(
                "user_id",
                sa.String(length=36),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column("model_version", sa.String(length=200), nullable=False),
            sa.Column("experience_vec", sa.LargeBinary(), nullable=True),
            sa.Column("prefs_vec", sa.LargeBinary(), nullable=True),
            sa.Column(
                "title_vecs", sa.JSON(), nullable=False, server_default=sa.text("'[]'")
            ),
            sa.Column(
                "skills", sa.JSON(), nullable=False, server_default=sa.text("'{}'")
            ),
            sa.Column("years_experience", sa.Float(), nullable=True),
            sa.Column("has_degree", sa.Boolean(), nullable=True),
            sa.Column("profile_hash", sa.String(length=64), nullable=True),
            sa.Column(
                "encoded_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
            ),
        )

    if "match_engine_comparisons" not in tables:
        op.create_table(
            "match_engine_comparisons",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column(
                "job_id",
                sa.String(length=36),
                sa.ForeignKey("jobs.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "user_id",
                sa.String(length=36),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("llm_overall", sa.Integer(), nullable=False),
            sa.Column("vector_overall", sa.Integer(), nullable=False),
            sa.Column(
                "llm_dimensions", sa.JSON(), nullable=False, server_default=sa.text("'{}'")
            ),
            sa.Column(
                "vector_dimensions", sa.JSON(), nullable=False, server_default=sa.text("'{}'")
            ),
            sa.Column(
                "created_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
            ),
        )
        op.create_index(
            "ix_match_engine_comparisons_job_id", "match_engine_comparisons", ["job_id"]
        )
        op.create_index(
            "ix_match_engine_comparisons_user_id", "match_engine_comparisons", ["user_id"]
        )
        op.create_index(
            "ix_match_engine_comparisons_created_at",
            "match_engine_comparisons",
            ["created_at"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "match_engine_comparisons" in tables:
        op.drop_table("match_engine_comparisons")
    if "user_encodings" in tables:
        op.drop_table("user_encodings")
    if "job_encodings" in tables:
        op.drop_table("job_encodings")
