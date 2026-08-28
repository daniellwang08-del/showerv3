#!/usr/bin/env bash
# One-off audit: report any lingering reference to a retired domain in the
# production database. Config lives in .env, but some settings (auto-post
# targets, user-supplied links) are stored as rows, so they need checking too.
#
# There is no psql on this box, so the query runs through the app's own venv,
# the same way the deploy workflow inspects scrape_runs.
#
# Usage: scan-old-domain.sh [needle]   (default: robertstaff)
set -euo pipefail

NEEDLE="${1:-robertstaff}"
cd /opt/showerv3

DBURL=$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
DBURL=$(echo "$DBURL" | sed 's/postgresql+asyncpg/postgresql/' | sed 's/+asyncpg//')

DBURL="$DBURL" NEEDLE="$NEEDLE" /opt/showerv3/venv/bin/python - <<'PY'
import os

from sqlalchemy import create_engine, text

needle = f"%{os.environ['NEEDLE']}%"
engine = create_engine(os.environ["DBURL"])

with engine.connect() as conn:
    # Scan every character / json column in the schema rather than guessing
    # which table might hold a URL.
    columns = conn.execute(
        text(
            """
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND data_type IN ('text', 'character varying', 'character', 'json', 'jsonb')
            ORDER BY table_name, column_name
            """
        )
    ).fetchall()

    hits = []
    for table, column in columns:
        stmt = text(f'SELECT count(*) FROM public."{table}" WHERE "{column}"::text ILIKE :needle')
        try:
            n = conn.execute(stmt, {"needle": needle}).scalar() or 0
        except Exception as exc:  # unreadable column should not abort the audit
            print(f"  ! {table}.{column}: {exc.__class__.__name__}")
            continue
        if n:
            hits.append((table, column, n))

    print(f"scanned {len(columns)} columns")
    if hits:
        print("MATCHES:")
        for table, column, n in hits:
            print(f"  {table}.{column}: {n} row(s)")
    else:
        print("no matches")
PY

echo "=== done ==="
