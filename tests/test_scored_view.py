"""The board's "Scored" tab (view id ``available``) only lists scored jobs."""

from app.api.routes import _dashboard_view_clauses


def _sql(clauses) -> str:
    return " AND ".join(str(c.compile(compile_kwargs={"literal_binds": True})) for c in clauses)


def test_scored_view_requires_match_score_and_match_join():
    clauses, needs_match_join = _dashboard_view_clauses("available", min_score=0, user_id="u1")

    assert needs_match_join is True
    sql = _sql(clauses)
    assert "job_match_results.overall_score IS NOT NULL" in sql
    assert "job_extractions.status IN" in sql


def test_ready_view_does_not_require_match_join():
    _clauses, needs_match_join = _dashboard_view_clauses("ready", min_score=0, user_id="u1")

    assert needs_match_join is False
