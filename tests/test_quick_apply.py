from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace

from app.services import post_analysis_dedup as pad
from app.services import quick_apply as qa

POSTING = (
    "Senior Backend Engineer\n"
    "Acme Robotics is hiring a backend engineer to build Python services on AWS. "
    "You will own APIs, data pipelines and on-call for the platform team."
)


class TestMarker:
    def test_only_the_user_who_pasted_it(self):
        meta = {qa.QUICK_APPLY_KEY: ["u1", "u2"]}
        assert qa.is_quick_apply_for(meta, "u1")
        assert qa.is_quick_apply_for(meta, "u2")
        assert not qa.is_quick_apply_for(meta, "u3")
        assert not qa.is_quick_apply_for({}, "u1")
        assert not qa.is_quick_apply_for(None, "u1")
        assert not qa.is_quick_apply_for(meta, None)

    def test_marking_is_idempotent_and_keeps_other_metadata(self):
        job = SimpleNamespace(raw_metadata={"submitted_by_user_id": "u1", qa.QUICK_APPLY_KEY: ["u0"]})
        qa._mark_quick_apply(job, "u1")
        qa._mark_quick_apply(job, "u1")
        assert job.raw_metadata[qa.QUICK_APPLY_KEY] == ["u0", "u1"]
        assert job.raw_metadata["submitted_by_user_id"] == "u1"


class TestPastedUrl:
    def test_same_text_same_url_regardless_of_whitespace_and_case(self):
        a = qa.pasted_job_url("u1", POSTING)
        b = qa.pasted_job_url("u1", "  " + POSTING.upper().replace(" ", "   ") + "\n")
        assert a == b
        assert f"?{qa.PASTED_URL_PARAM}=" in a

    def test_differs_per_user_and_per_posting(self):
        assert qa.pasted_job_url("u1", POSTING) != qa.pasted_job_url("u2", POSTING)
        assert qa.pasted_job_url("u1", POSTING) != qa.pasted_job_url("u1", POSTING + " Remote.")

    def test_survives_url_normalization(self):
        from app.services.url_manager import URLManager

        url = qa.pasted_job_url("u1", POSTING)
        assert URLManager.validate_url(url)[0]
        assert f"{qa.PASTED_URL_PARAM}=" in URLManager.normalize_url(url)


class TestUrlReuse:
    def _ext(self, text, manual=True):
        return SimpleNamespace(raw_metadata={"manual_jd": True} if manual else {}, raw_plain_text=text)

    def test_same_paste_reuses(self):
        assert not qa._holds_other_paste(self._ext(POSTING), "  " + POSTING.lower())

    def test_different_paste_on_same_url_does_not_reuse(self):
        assert qa._holds_other_paste(self._ext(POSTING), POSTING + " Also: Kubernetes.")

    def test_scraped_posting_is_reused(self):
        assert not qa._holds_other_paste(self._ext("scraped text", manual=False), POSTING)
        assert not qa._holds_other_paste(None, POSTING)


class TestGuessHeader:
    def _patch_llm(self, monkeypatch, *, raw=None, error=None):
        import app.core.llm_client as llm

        async def fake_client(*_a, **_k):
            if error:
                raise error
            return object()

        async def fake_completion(*_a, **_k):
            return raw, None

        monkeypatch.setattr(llm, "get_llm_client_for_user", fake_client)
        monkeypatch.setattr(llm, "chat_completion_with_empty_retry", fake_completion)

    def test_reads_title_company_location(self, monkeypatch):
        self._patch_llm(
            monkeypatch,
            raw='{"is_job_posting": true, "title": "Senior Backend Engineer", "company": "Acme Robotics", "location": "Remote"}',
        )
        out = asyncio.run(qa.guess_job_header("u1", POSTING))
        assert out == {
            "title": "Senior Backend Engineer",
            "company": "Acme Robotics",
            "location": "Remote",
            "is_job_posting": True,
        }

    def test_placeholder_values_are_dropped(self, monkeypatch):
        self._patch_llm(monkeypatch, raw='{"is_job_posting": true, "title": "Engineer", "company": "Unknown", "location": "null"}')
        out = asyncio.run(qa.guess_job_header("u1", POSTING))
        assert out["company"] is None and out["location"] is None

    def test_llm_failure_falls_back_to_first_line(self, monkeypatch):
        self._patch_llm(monkeypatch, error=RuntimeError("provider down"))
        out = asyncio.run(qa.guess_job_header("u1", POSTING))
        assert out["title"] == "Senior Backend Engineer"
        assert out["company"] is None
        assert out["is_job_posting"] is True

    def test_not_a_posting(self, monkeypatch):
        self._patch_llm(monkeypatch, raw='{"is_job_posting": false, "title": null, "company": null}')
        out = asyncio.run(qa.guess_job_header("u1", "hello there, how are you doing today?"))
        assert out["is_job_posting"] is False
        assert out["title"] is None


class _Result:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class TestDedupBypass:
    def _run(self, monkeypatch, raw_metadata, match_data):
        job = SimpleNamespace(id="j1", raw_metadata=raw_metadata, extraction_id=None)

        class Session:
            async def execute(self, *_a, **_k):
                return _Result(job)

        @asynccontextmanager
        async def fake_session():
            yield Session()

        saved = {}

        async def fake_save_active(_session, job_id, user_id, _match, score):
            saved.update(job_id=job_id, user_id=user_id, score=score)
            return {"action": "saved_active", "job_id": job_id, "score": score}

        from app.storage import user_repository as ur

        async def zero(*_a, **_k):
            return 0

        async def enabled(*_a, **_k):
            return True

        monkeypatch.setattr(pad, "get_session", fake_session)
        monkeypatch.setattr(pad, "_save_active", fake_save_active)
        monkeypatch.setattr(ur.UserRepository, "get_dedup_recycle_days", zero)
        monkeypatch.setattr(ur.UserRepository, "get_effective_min_match_score", zero)
        monkeypatch.setattr(ur.UserRepository, "get_effective_dedup_applied_company_enabled", enabled)
        monkeypatch.setattr(ur.UserRepository, "get_effective_dedup_score_comparison_enabled", enabled)
        out = asyncio.run(pad.run_post_analysis_dedup("j1", "u1", match_data, None))
        return out, saved

    def test_quick_apply_job_stays_active_even_with_a_zero_score(self, monkeypatch):
        out, saved = self._run(
            monkeypatch,
            {qa.QUICK_APPLY_KEY: ["u1"]},
            {"overall_score": 0, "is_job_posting": False, "requires_security_clearance": True},
        )
        assert out["action"] == "saved_active"
        assert out["quick_apply"] is True
        assert saved == {"job_id": "j1", "user_id": "u1", "score": 0}

    def test_another_users_paste_does_not_bypass(self, monkeypatch):
        async def fake_dup(_session, **kw):
            return {"action": "saved_duplicated", "exclusion_type": kw["exclusion_type"]}

        monkeypatch.setattr(pad, "_save_duplicated", fake_dup)
        out, saved = self._run(monkeypatch, {qa.QUICK_APPLY_KEY: ["u2"]}, {"overall_score": 0})
        assert out["action"] == "saved_duplicated"
        assert "quick_apply" not in out
        assert saved == {}
