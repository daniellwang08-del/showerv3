import asyncio
from contextlib import asynccontextmanager

import pytest

from app.models.database import ResumeBuildResult, User
from app.services import credit_service, job_match_orchestrator, resume_ai_chat_service
from app.services.store_service import StoreError


def run(coro):
    return asyncio.run(coro)


class _Result:
    def __init__(self, scalar=None):
        self._scalar = scalar

    def scalar_one_or_none(self):
        return self._scalar

    def scalar_one(self):
        return self._scalar


class _Session:
    def __init__(self, *results, objects=None):
        self._results = list(results)
        self.objects = objects or {}

    async def execute(self, _stmt):
        return self._results.pop(0)

    async def get(self, _model, key):
        return self.objects.get(key)

    async def commit(self):
        return None


class Bank:
    """One user's balance and ledger, with the same rules as ``store_service.add_credits``."""

    def __init__(self, balance=50, is_admin=False):
        self.balance = balance
        self.is_admin = is_admin
        self.ledger: list[tuple[int, str, str | None]] = []
        self.prepared: set[str] = set()

    def paid_for(self, job_id):
        return sum(
            d
            for d, reason, ref in self.ledger
            if ref == job_id and reason in (credit_service.JOB_PREPARE, credit_service.JOB_PREPARE_REFUND)
        )


@pytest.fixture
def bank(monkeypatch):
    b = Bank()

    @asynccontextmanager
    async def fake_session():
        yield _Session(objects={"u": User(id="u", is_admin=b.is_admin, credit_balance=b.balance)})

    async def payer(_session, _user_id):
        return None if b.is_admin else object()

    async def is_free(_session, job_id, _user_id):
        return job_id in b.prepared or b.paid_for(job_id) < 0

    async def add(_session, _user_id, delta, *, reason, ref_id=None, note=None):
        if delta < 0 and b.balance < -delta:
            raise StoreError("Not enough credits.")
        b.balance += delta
        b.ledger.append((delta, reason, ref_id))
        return b.balance

    async def label(_session, _job_id):
        return "Engineer at Acme"

    monkeypatch.setattr(credit_service, "get_session", fake_session)
    monkeypatch.setattr(credit_service, "_payer", payer)
    monkeypatch.setattr(credit_service, "_preparation_is_free", is_free)
    monkeypatch.setattr(credit_service, "add_credits", add)
    monkeypatch.setattr(credit_service, "_job_label", label)
    return b


# â”€â”€ Credit rules â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


def test_preparing_a_job_costs_one_credit_once(bank):
    assert run(credit_service.charge_job_preparation("j1", "u")) is True
    assert bank.balance == 49
    # A rerun while the first is running (or after it was paid) is free.
    assert run(credit_service.charge_job_preparation("j1", "u")) is False
    assert bank.balance == 49
    assert bank.ledger == [(-1, "job_prepare", "j1")]


def test_refund_makes_the_next_attempt_chargeable_again(bank):
    run(credit_service.charge_job_preparation("j1", "u"))
    run(credit_service.refund_job_preparation("j1", "u"))
    assert bank.balance == 50
    assert run(credit_service.charge_job_preparation("j1", "u")) is True
    assert bank.balance == 49


def test_already_prepared_jobs_are_free(bank):
    bank.prepared.add("legacy")
    assert run(credit_service.charge_job_preparation("legacy", "u")) is False
    assert bank.balance == 50 and bank.ledger == []


def test_out_of_credits_raises_and_changes_nothing(bank):
    bank.balance = 0
    with pytest.raises(credit_service.OutOfCredits):
        run(credit_service.charge_job_preparation("j1", "u"))
    with pytest.raises(credit_service.OutOfCredits):
        run(credit_service.charge_tailoring("u"))
    assert bank.balance == 0 and bank.ledger == []


def test_admins_never_pay(bank):
    bank.is_admin = True
    bank.balance = 0
    assert run(credit_service.charge_job_preparation("j1", "u")) is False
    assert run(credit_service.charge_tailoring("u")) is None
    assert run(credit_service.can_prepare("j1", "u")) is True
    assert run(credit_service.spendable_credits("u")) is None


def test_can_prepare_follows_balance_and_free_reruns(bank):
    assert run(credit_service.can_prepare("j1", "u")) is True
    bank.balance = 0
    assert run(credit_service.can_prepare("j1", "u")) is False
    bank.prepared.add("j1")
    assert run(credit_service.can_prepare("j1", "u")) is True


def test_tailoring_charge_and_refund_use_their_own_reference(bank):
    charge = run(credit_service.charge_tailoring("u", note="Engineer at Acme"))
    assert charge and bank.balance == 49
    run(credit_service.refund_tailoring("u", charge))
    run(credit_service.refund_tailoring("u", None))
    assert bank.balance == 50
    assert bank.ledger == [(-1, "tailor", charge), (1, "tailor_refund", charge)]


def test_preparation_is_free_reads_content_then_unrefunded_charges():
    with_content = ResumeBuildResult(tailored_resume_data={"summary": "x"})
    assert run(credit_service._preparation_is_free(_Session(_Result(with_content)), "j", "u")) is True
    letter_only = ResumeBuildResult(cover_letter_data={"body": "Dear team"})
    assert run(credit_service._preparation_is_free(_Session(_Result(letter_only)), "j", "u")) is True
    placeholder = ResumeBuildResult(cover_letter_data={"body": ""})
    assert run(credit_service._preparation_is_free(_Session(_Result(placeholder), _Result(0)), "j", "u")) is False
    assert run(credit_service._preparation_is_free(_Session(_Result(None), _Result(-1)), "j", "u")) is True
    assert run(credit_service._preparation_is_free(_Session(_Result(None), _Result(None)), "j", "u")) is False


# â”€â”€ Job preparation (Phase B) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


@pytest.fixture
def phase_b(monkeypatch, bank):
    state = {"result": ({"summary": "tailored"}, {"body": "Dear team"}), "builds": {}, "events": [], "docs": 0}

    class Build:
        def __init__(self):
            self.status = None
            self.error = None

    class Repo:
        def __init__(self, _session):
            pass

        def _row(self, job_id):
            return state["builds"].setdefault(job_id, Build())

        async def get(self, job_id, _user_id):
            return state["builds"].get(job_id)

        async def mark_content_generating(self, job_id, _user_id):
            self._row(job_id).status = "processing"

        async def fail_content_generation(self, job_id, _user_id, error):
            row = self._row(job_id)
            row.status, row.error = "failed", error

        async def complete_content_generation(self, job_id, _user_id, **_kw):
            self._row(job_id).status = "completed"
            bank.prepared.add(job_id)

        async def mark_content_skipped(self, job_id, _user_id):
            self._row(job_id).status = "skipped"

    class Nothing:
        def __init__(self, _session):
            pass

        async def get_by_id(self, _id):
            return None

        async def get(self, *_a):
            return None

        async def list_completed_for_user(self, _user_id):
            return []

    @asynccontextmanager
    async def fake_session():
        yield _Session()

    async def no_skip(*_a, **_k):
        return None

    async def tailored_mode(_user_id):
        return False

    async def loaded(*_a):
        return ("ext", "Job text", "Profile text")

    async def phase_b_call(*_a, **_k):
        if isinstance(state["result"], BaseException):
            raise state["result"]
        return state["result"]

    async def publish(event):
        state["events"].append(event)

    async def build_docs(*_a):
        state["docs"] += 1

    from app.services import job_pipeline_mode

    o = job_match_orchestrator
    monkeypatch.setattr(o, "get_session", fake_session)
    monkeypatch.setattr(o, "ResumeBuildRepository", Repo)
    monkeypatch.setattr(o, "JobExtractionRepository", Nothing)
    monkeypatch.setattr(o, "JobMatchRepository", Nothing)
    monkeypatch.setattr(o, "UserRepository", Nothing)
    monkeypatch.setattr(o, "ProfileSourceDocumentRepository", Nothing)
    monkeypatch.setattr(o, "_tailoring_skip_reason", no_skip)
    monkeypatch.setattr(o, "_load_job_and_profile", loaded)
    monkeypatch.setattr(o, "generate_tailored_content_phase_b", phase_b_call)
    monkeypatch.setattr(o, "publish_ws_event", publish)
    monkeypatch.setattr(o, "_enqueue_resume_doc_build", build_docs)
    monkeypatch.setattr(job_pipeline_mode, "user_uses_original_resume", tailored_mode)
    return state


def test_successful_preparation_keeps_the_credit(bank, phase_b):
    assert run(job_match_orchestrator.run_tailored_content_generation("j1", "u"))
    assert bank.balance == 49
    assert phase_b["builds"]["j1"].status == "completed"
    assert phase_b["docs"] == 1
    # Regenerating a prepared job is free.
    run(job_match_orchestrator.run_tailored_content_generation("j1", "u", manual=True))
    assert bank.balance == 49


def test_failed_preparation_returns_the_credit(bank, phase_b):
    phase_b["result"] = RuntimeError("provider down")
    assert run(job_match_orchestrator.run_tailored_content_generation("j1", "u")) is None
    assert bank.balance == 50
    assert [r for _, r, _ in bank.ledger] == ["job_prepare", "job_prepare_refund"]
    assert phase_b["builds"]["j1"].status == "failed"


def test_missing_resume_section_returns_the_credit(bank, phase_b):
    phase_b["result"] = (None, {"body": "Dear team"})
    run(job_match_orchestrator.run_tailored_content_generation("j1", "u"))
    assert bank.balance == 50


def test_cancelled_preparation_returns_the_credit(bank, phase_b):
    phase_b["result"] = asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError):
        run(job_match_orchestrator.run_tailored_content_generation("j1", "u"))
    assert bank.balance == 50


def test_no_credits_pauses_preparation_with_a_clear_message(bank, phase_b):
    bank.balance = 0
    assert run(job_match_orchestrator.run_tailored_content_generation("j1", "u", manual=True)) is None
    build = phase_b["builds"]["j1"]
    assert build.status == "failed"
    assert build.error == credit_service.NO_CREDITS_MESSAGE
    assert phase_b["events"][-1]["reason"] == "no_credits"
    assert bank.ledger == [] and phase_b["docs"] == 0


def test_automatic_preparation_is_not_queued_without_credits(bank, monkeypatch):
    bank.balance = 0

    async def no_pool():
        raise AssertionError("must not reach the queue")

    from app.tasks import worker

    monkeypatch.setattr(worker, "get_tailoring_pool", no_pool)
    assert run(job_match_orchestrator.enqueue_tailored_content_generation("j1", "u")) is False


# â”€â”€ Tailoring from a pasted job description â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


@pytest.fixture
def pipeline(monkeypatch, bank):
    state = {"result": ({"summary": "tailored"}, {"body": "Dear team"}), "phase_b_calls": 0}

    @asynccontextmanager
    async def fake_session():
        yield _Session()

    class Profile:
        def __init__(self, _session):
            pass

        async def get_profile_openai_text(self, _user_id):
            return "Backend engineer"

        async def get_by_id(self, _user_id):
            return None

    async def phase_a(*_a, **_k):
        return {"overall_score": 80}, None, True

    async def phase_b_call(*_a, **_k):
        state["phase_b_calls"] += 1
        if isinstance(state["result"], BaseException):
            raise state["result"]
        return state["result"]

    class NoDocs:
        def __init__(self, _session):
            pass

        async def list_completed_for_user(self, _user_id):
            return []

    from app.storage import profile_source_document_repository

    monkeypatch.setattr(profile_source_document_repository, "ProfileSourceDocumentRepository", NoDocs)
    m = resume_ai_chat_service
    monkeypatch.setattr(m, "get_session", fake_session)
    monkeypatch.setattr(m, "UserRepository", Profile)
    monkeypatch.setattr(m, "analyze_job_match_phase_a", phase_a)
    monkeypatch.setattr(m, "generate_tailored_content_phase_b", phase_b_call)
    return state


def test_tailoring_costs_a_credit(bank, pipeline):
    out = run(resume_ai_chat_service._run_pipeline("u", "JD", want_tailor=True))
    assert out["tailored"] and bank.balance == 49


def test_scoring_only_is_free(bank, pipeline):
    run(resume_ai_chat_service._run_pipeline("u", "JD", want_tailor=False))
    assert bank.balance == 50 and bank.ledger == []


def test_empty_or_failed_tailoring_is_refunded(bank, pipeline):
    pipeline["result"] = (None, None)
    run(resume_ai_chat_service._run_pipeline("u", "JD", want_tailor=True))
    assert bank.balance == 50
    pipeline["result"] = RuntimeError("provider down")
    with pytest.raises(RuntimeError):
        run(resume_ai_chat_service._run_pipeline("u", "JD", want_tailor=True))
    assert bank.balance == 50


def test_tailoring_without_credits_skips_the_ai_call(bank, pipeline):
    bank.balance = 0
    out = run(resume_ai_chat_service._run_pipeline("u", "JD", want_tailor=True))
    assert out["error"] == "no_credits"
    assert out["match"] == {"overall_score": 80}
    assert pipeline["phase_b_calls"] == 0
