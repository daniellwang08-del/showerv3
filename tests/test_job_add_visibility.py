import asyncio

from sqlalchemy.dialects import postgresql

from app.services.job_add_batches import job_owner_id, job_share_visibility_clause


def test_applicant_url_add_is_owned_by_the_submitter():
    meta = {"submitted_data": {"title": "x"}, "submitted_by_user_id": "u1", "submitted_by_admin": False}
    assert job_owner_id(meta) == "u1"


def test_admin_url_add_is_shared_inventory():
    meta = {"submitted_data": {}, "submitted_by_user_id": "admin", "submitted_by_admin": True}
    assert job_owner_id(meta) is None


def test_company_source_and_connected_site_jobs_belong_to_the_user():
    assert job_owner_id({"scraped_source": "user_site", "user_job_source": {"user_id": "u2"}}) == "u2"
    assert job_owner_id({"scraped_source": "linkedin", "user_job_site": {"user_id": "u3"}}) == "u3"


def test_scraped_inventory_has_no_owner():
    assert job_owner_id({"scraped_source": "remoterocketship"}) is None
    assert job_owner_id(None) is None


def test_visibility_clause_keeps_owner_and_hides_unbatched_owned_jobs():
    sql = str(
        job_share_visibility_clause("viewer").compile(
            dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}
        )
    )
    assert "submitted_by_user_id" in sql
    assert "user_job_source" in sql and "user_job_site" in sql
    assert "IS NULL" in sql


def test_source_sync_records_one_add_session_for_new_and_linked_jobs(monkeypatch):
    from app.services import job_add_batches, job_source_sync

    outcomes = iter([("created", "j1"), ("skipped", None), ("linked", "j2")])
    recorded = {}

    async def fake_process(board_job, *, added_ids, **_kwargs):
        outcome, job_id = next(outcomes)
        if job_id:
            added_ids.append(job_id)
        return outcome

    async def fake_record(user_id, job_ids, *, source):
        recorded.update(user_id=user_id, job_ids=list(job_ids), source=source)

    monkeypatch.setattr(job_source_sync, "_process_listing_job", fake_process)
    monkeypatch.setattr(job_add_batches, "record_job_add", fake_record)

    counts = asyncio.run(
        job_source_sync.ingest_board_jobs(
            [object(), object(), object()],
            user_id="u1",
            scraped_source="user_site",
            company_fallback="Acme",
            extra_meta={},
            chain_analysis=False,
            skip_phase_b=True,
        )
    )
    assert counts == {"created": 1, "linked": 1, "skipped": 1}
    assert recorded == {"user_id": "u1", "job_ids": ["j1", "j2"], "source": "site"}
