from sqlalchemy import column
from sqlalchemy.dialects import postgresql

from app.services.job_exclusion_types import (
    matches_invalid_job_category,
    sql_filter_for_invalid_category,
)
from app.services.post_analysis_dedup import _first_company_token, normalize_company


class _Tasks:
    def __init__(self):
        self.calls = []

    def add_task(self, fn, *args):
        self.calls.append((fn.__name__, args))


def _settings(**overrides):
    base = {
        "min_match_score": 50,
        "dedup_applied_company_enabled": False,
        "dedup_score_comparison_enabled": False,
        "dedup_recycle_days": 30,
    }
    return {**base, **overrides}


def test_raising_min_score_reconciles_existing_jobs():
    from app.api.routes import schedule_job_rule_reconciles

    tasks = _Tasks()
    schedule_job_rule_reconciles(tasks, "u1", _settings(), _settings(min_match_score=60))
    assert tasks.calls == [("reconcile_min_match_score_for_user", ("u1", 60))]


def test_changing_dedup_rules_reconciles_existing_jobs():
    from app.api.routes import schedule_job_rule_reconciles

    tasks = _Tasks()
    schedule_job_rule_reconciles(
        tasks, "u1", _settings(), _settings(dedup_applied_company_enabled=True)
    )
    assert tasks.calls == [("reconcile_dedup_rules_for_user", ("u1",))]


def test_unrelated_saves_do_not_reconcile():
    from app.api.routes import schedule_job_rule_reconciles

    tasks = _Tasks()
    schedule_job_rule_reconciles(tasks, "u1", _settings(), _settings())
    assert tasks.calls == []


def _sql(category):
    expr = sql_filter_for_invalid_category(column("exclusion_type"), category)
    return str(expr.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))


def test_every_exclusion_type_lands_in_exactly_one_invalid_tab():
    types = [
        None, "same_url", "strict_similarity", "lower_score", "superseded_by_higher",
        "applied_company", "blocked_domain", "linkedin_job", "manual_duplicate",
        "below_min_score", "not_a_job_posting", "security_clearance",
        "extraction_failed", "non_us_location", "outside_preferred_countries",
    ]
    tabs = ("duplicates", "low_score", "extraction_failed", "non_us")
    for exclusion_type in types:
        hits = [t for t in tabs if matches_invalid_job_category(exclusion_type, t)]
        assert len(hits) == 1, (exclusion_type, hits)


def test_low_score_tab_filter_covers_postings_and_clearance():
    sql = _sql("low_score")
    for exclusion_type in ("below_min_score", "not_a_job_posting", "security_clearance"):
        assert exclusion_type in sql


def test_company_prefilter_token_survives_suffixes_and_punctuation():
    assert _first_company_token("Acme Inc.") == "acme"
    assert _first_company_token("The Acme Corporation") == "acme"
    assert _first_company_token("Booking.com") == "booking"
    assert normalize_company("Acme Inc.") == normalize_company("acme")
