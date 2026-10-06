"""Durable per-call LLM usage for admin cost reporting.

Backfills from the ``llm_call_completed`` rows still in system_log_events
(those are purged after the log retention window), so reports cover the time
before this table existed. Cost is priced from the logged model id.

Revision ID: 082_llm_usage_events
Revises: 081_location_without_work_mode
Create Date: 2026-10-06
"""

from __future__ import annotations

import uuid

import sqlalchemy as sa
from alembic import op

from app.services.llm_pricing import estimate_cost_usd

revision = "082_llm_usage_events"
down_revision = "081_location_without_work_mode"
branch_labels = None
depends_on = None


def _int(value) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _backfill(conn) -> int:
    rows = conn.execute(
        sa.text(
            """
            SELECT created_at, user_id, job_id, request_id, worker_job_type,
                   payload->>'job_type', payload->>'observe', payload->>'model',
                   payload->>'provider', payload->>'usage_prompt',
                   payload->>'usage_completion', payload->>'usage_reasoning'
            FROM system_log_events
            WHERE event = 'llm_call_completed'
            """
        )
    ).fetchall()
    insert = sa.text(
        """
        INSERT INTO llm_usage_events
            (id, created_at, user_id, job_id, run_id, feature, operation, provider, model,
             prompt_tokens, completion_tokens, reasoning_tokens, total_tokens, cost_usd, estimated)
        VALUES
            (:id, :created_at, :user_id, :job_id, :run_id, :feature, :operation, :provider, :model,
             :prompt, :completion, :reasoning, :total, :cost, false)
        """
    )
    batch = []
    for r in rows:
        prompt, completion = _int(r[9]), _int(r[10])
        batch.append(
            {
                "id": str(uuid.uuid4()),
                "created_at": r[0],
                "user_id": r[1],
                "job_id": r[2],
                "run_id": r[3],
                "feature": (r[5] or r[4] or r[6] or "other")[:80],
                "operation": (r[6] or None) and r[6][:80],
                "provider": (r[8] or "openai")[:20],
                "model": (r[7] or None) and r[7][:200],
                "prompt": prompt,
                "completion": completion,
                "reasoning": _int(r[11]),
                "total": prompt + completion,
                "cost": estimate_cost_usd(r[7], prompt, completion),
            }
        )
    for i in range(0, len(batch), 500):
        conn.execute(insert, batch[i : i + 500])
    return len(batch)


def upgrade() -> None:
    op.create_table(
        "llm_usage_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("user_id", sa.String(36), nullable=True),
        sa.Column("job_id", sa.String(36), nullable=True),
        sa.Column("run_id", sa.String(64), nullable=True),
        sa.Column("feature", sa.String(80), nullable=False),
        sa.Column("operation", sa.String(80), nullable=True),
        sa.Column("provider", sa.String(20), nullable=True),
        sa.Column("model", sa.String(200), nullable=True),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("completion_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reasoning_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cost_usd", sa.Float(), nullable=True),
        sa.Column("estimated", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_llm_usage_events_created_at", "llm_usage_events", ["created_at"])
    op.create_index("ix_llm_usage_events_user_created", "llm_usage_events", ["user_id", "created_at"])
    op.create_index("ix_llm_usage_events_feature_created", "llm_usage_events", ["feature", "created_at"])
    count = _backfill(op.get_bind())
    print(f"Backfilled llm_usage_events from system logs: {count}")


def downgrade() -> None:
    op.drop_index("ix_llm_usage_events_feature_created", table_name="llm_usage_events")
    op.drop_index("ix_llm_usage_events_user_created", table_name="llm_usage_events")
    op.drop_index("ix_llm_usage_events_created_at", table_name="llm_usage_events")
    op.drop_table("llm_usage_events")
