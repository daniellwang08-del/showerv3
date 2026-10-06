import asyncio
import json

import pytest

from app.api import agent_routes
from app.core.llm_client import llm_failure_message
from app.services import resume_ai_chat_service, resume_design_service
from app.services.agent import catalog, orchestrator
from app.services.agent.base import ToolContext, get_tool

JD = (
    "Software Engineer III at Vaco, on assignment with Meta. You will build backend services in "
    "Python and Go, own features end to end, partner with product, review code and mentor others. "
    "Requirements: 5+ years of software engineering and strong distributed systems fundamentals."
)


def run(coro):
    return asyncio.run(coro)


class RateLimitError(Exception):
    pass


class AuthenticationError(Exception):
    pass


def test_failure_message_names_the_real_cause():
    out_of_credits = RateLimitError(
        "Error code: 429 - {'error': {'message': 'You have no credits remaining', 'code': 'insufficient_quota'}}"
    )
    assert "out of credits" in llm_failure_message(out_of_credits)
    assert llm_failure_message(out_of_credits, feature="Tailoring").startswith("Tailoring can't run")
    assert "too many requests" in llm_failure_message(RateLimitError("slow down"))
    assert "rejected the API key" in llm_failure_message(AuthenticationError("invalid_api_key"))
    assert llm_failure_message(ValueError("boom")) == "The assistant is temporarily unavailable. Please try again."
    for exc in (out_of_credits, RateLimitError("x"), AuthenticationError("x"), ValueError("x")):
        assert "\u2014" not in llm_failure_message(exc)


def test_job_description_comes_from_the_users_own_text():
    ctx = ToolContext(user_id="u", user_message=f"Tailor my resume.\n\n{JD}")
    assert catalog._job_description_from(ctx, {"job_description": "model retyped this"}).endswith(JD)

    follow_up = ToolContext(user_id="u", user_message="now do it", earlier_user_messages=("hi", JD))
    assert catalog._job_description_from(follow_up, {}) == JD

    assert catalog._job_description_from(ToolContext(user_id="u", user_message="tailor it"), {}) == ""


@pytest.fixture
def tailoring(monkeypatch):
    state = {"saved": None, "fail": None, "delay": 0.0, "pipeline_args": None, "pipeline_kwargs": None}

    async def fake_pipeline(user_id, job_text, *, want_tailor, extra_instructions="", emit=None, **kwargs):
        state["pipeline_args"] = (user_id, job_text, want_tailor, extra_instructions)
        state["pipeline_kwargs"] = kwargs
        if state["fail"]:
            raise state["fail"]
        await emit({"stage": "reading", "label": "Reading the job description"})
        await emit({"stage": "analyzing", "label": "Scoring your match to the role"})
        if state["delay"]:
            await asyncio.sleep(state["delay"])
        await emit({"stage": "evidence", "label": "Gathering proof"})
        await emit({"stage": "tailoring", "label": "Rewriting your resume for this job"})
        return {
            "is_job_posting": True,
            "match": {"overall_score": 78.4},
            "job_title": "Software Engineer III",
            "company": "Vaco",
            "tailored": {"summary": "Backend engineer"},
            "cover_letter": "Dear hiring team" if kwargs.get("want_cover_letter") else None,
        }

    async def fake_save(user_id, content, job_title, company, activate=True, cover_letter=None, **kwargs):
        state["saved"] = {"content": content, "activate": activate, "cover_letter": cover_letter, **kwargs}
        return {"resume": {"id": "r1", "name": "Vaco Software Engineer III"}}

    monkeypatch.setattr(resume_ai_chat_service, "_run_pipeline", fake_pipeline)
    monkeypatch.setattr(resume_design_service, "save_ai_tailored_as_library_resume", fake_save)
    return state


def test_tailor_saves_resume_only_unless_cover_letter_asked(tailoring):
    reports = []

    async def progress(label, **detail):
        reports.append((label, detail))

    ctx = ToolContext(user_id="u", user_message=JD, progress=progress)
    result = run(catalog._tailor_resume(ctx, {"instructions": "focus on Go"}))
    assert result.ok
    assert tailoring["pipeline_args"] == ("u", JD, True, "focus on Go")
    assert tailoring["pipeline_kwargs"] == {"want_cover_letter": False, "free_scoring": True}
    saved = tailoring["saved"]
    assert saved["cover_letter"] is None
    assert saved["activate"] is False
    assert saved["job_description"] == JD
    assert saved["match_score"] == 78.4
    assert saved["origin"] == "assistant"
    assert result.data["document"] == {
        "resume_id": "r1",
        "name": "Vaco Software Engineer III",
        "job_title": "Software Engineer III",
        "company": "Vaco",
        "has_cover_letter": False,
        "has_job_description": True,
        "match_score": 78,
    }
    assert result.refresh == ["documents"]
    assert "Match score 78" in result.summary

    final_steps = reports[-1][1]["steps"]
    assert [s["id"] for s in final_steps] == ["read", "score", "evidence", "resume", "quality", "save"]
    assert all(s["status"] == "done" for s in final_steps)
    assert reports[-1][1]["expected_seconds"] > 0

    with_letter = run(catalog._tailor_resume(ctx, {"include_cover_letter": "true"}))
    assert tailoring["pipeline_kwargs"]["want_cover_letter"] is True
    assert tailoring["saved"]["cover_letter"] == "Dear hiring team"
    assert with_letter.data["document"]["has_cover_letter"] is True


def test_checklist_marks_earlier_steps_done_and_runs_letter_with_resume():
    reports = []

    async def progress(label, **detail):
        reports.append((label, detail["steps"]))

    steps = catalog.TailorChecklist(ToolContext(user_id="u", progress=progress), include_letter=True)
    run(steps.stage("analyzing"))
    run(steps.stage("tailoring"))
    label, snapshot = reports[-1]
    status = {s["id"]: s["status"] for s in snapshot}
    assert status == {
        "read": "done",
        "score": "done",
        "evidence": "done",
        "resume": "active",
        "cover_letter": "active",
        "quality": "pending",
        "save": "pending",
    }
    assert label == "Writing your tailored resume"
    run(steps.fail())
    assert {s["status"] for s in reports[-1][1] if s["id"] in ("resume", "cover_letter")} == {"failed"}


def test_tailor_reports_the_provider_reason(tailoring):
    tailoring["fail"] = RateLimitError("insufficient_quota")
    result = run(catalog._tailor_resume(ToolContext(user_id="u", user_message=JD), {}))
    assert not result.ok
    assert "out of credits" in result.summary
    assert tailoring["saved"] is None


def test_tailor_asks_for_the_posting_when_missing(tailoring):
    result = run(catalog._tailor_resume(ToolContext(user_id="u", user_message="tailor my resume"), {}))
    assert not result.ok
    assert tailoring["pipeline_args"] is None


@pytest.fixture
def planner(monkeypatch):
    state = {"replies": [], "calls": 0}

    async def fake_client(_user_id, job_type=None):
        return object()

    async def fake_completion(_client, **kwargs):
        state["calls"] += 1
        reply = state["replies"].pop(0)
        if isinstance(reply, Exception):
            raise reply
        return json.dumps(reply), None

    monkeypatch.setattr(orchestrator, "get_llm_client_for_user", fake_client)
    monkeypatch.setattr(orchestrator, "chat_completion_with_empty_retry", fake_completion)
    return state


async def _collect(**kwargs):
    return [ev async for ev in orchestrator.run_agent_turn(user_id="u", **kwargs)]


def test_confirmed_tailor_streams_progress_and_heartbeat(tailoring, planner, monkeypatch):
    monkeypatch.setattr(orchestrator, "HEARTBEAT_SECONDS", 0.05)
    tailoring["delay"] = 0.2
    planner["replies"] = [{"message": "Your tailored resume is ready."}]
    events = run(
        _collect(
            message=f"Tailor my resume to this job description.\n\n{JD}",
            confirmed={"tool": "tailor_resume", "args": {"include_cover_letter": False}},
        )
    )
    types = [e["type"] for e in events]
    assert types[0] == "tool_call"
    assert "heartbeat" in types
    labels = [e["label"] for e in events if e["type"] == "progress"]
    assert labels[0] == "Reading the job description"
    assert "Writing your tailored resume" in labels
    assert labels[-2:] == ["Saving to Documents", "Tailoring your resume"]
    assert all(e.get("steps") for e in events if e["type"] == "progress")
    result = next(e for e in events if e["type"] == "tool_result")
    assert result["ok"] and result["data"]["document"]["resume_id"] == "r1"
    assert {"type": "refresh", "targets": ["documents"]} in events
    assert types.index("tool_result") > max(i for i, t in enumerate(types) if t == "progress")
    assert types[-2:] == ["message", "done"]


def test_planner_out_of_credits_is_reported_plainly(planner):
    planner["replies"] = [RateLimitError("Error code: 429 insufficient_quota credit_balance_exhausted")]
    events = run(_collect(message="Which jobs match me best?"))
    assert events == [
        {
            "type": "error",
            "message": (
                "The assistant can't run because the AI provider account is out of credits. "
                "An admin needs to add credits or a backup provider key under Admin, Settings, LLM."
            ),
        }
    ]


def test_tools_listing_has_labels_and_hides_admin_tools():
    tools = run(agent_routes.list_agent_tools(current_user={"user_id": "u"}))
    names = [t.name for t in tools]
    assert names[0] == "tailor_resume"
    assert not any(get_tool(n).admin_only for n in names)
    for t in tools:
        assert t.label and t.category
    tailor = tools[0]
    assert tailor.category == "Resume and cover letter"
    assert not tailor.requires_confirmation


POSTING = (
    "Hi There, Its Arun from Vaco. We are looking for a Senior Backend Engineer. "
    "Responsibilities: design and build Python services, own APIs end to end, mentor engineers. "
    "Requirements: 6+ years of experience with Python, PostgreSQL and AWS; strong skills in "
    "distributed systems. Benefits: medical, 401k. Salary: $160k to $190k. "
) * 2


def test_hard_route_catches_a_pasted_posting_with_a_tailoring_request():
    assert orchestrator.tailor_request_args(
        f"generate the tailored resume for this job description {POSTING}"
    ) == {"include_cover_letter": False}
    assert orchestrator.tailor_request_args(
        f"{POSTING}\n\nPlease tailor my resume and write a cover letter for this role."
    ) == {"include_cover_letter": True}
    assert orchestrator.tailor_request_args(
        f"Tailor my resume, no cover letter needed. {POSTING}"
    ) == {"include_cover_letter": False}


def test_hard_route_leaves_questions_and_bare_text_to_the_planner():
    assert orchestrator.tailor_request_args("Tailor my resume for the Vaco job") is None
    assert orchestrator.tailor_request_args(POSTING) is None
    assert orchestrator.tailor_request_args("Which jobs match me best? " * 30) is None


def test_pasted_posting_runs_tailoring_without_asking_the_planner_first(tailoring, planner):
    planner["replies"] = [{"message": "Saved your tailored resume."}]
    events = run(_collect(message=f"generate the tailored resume for this job description\n\n{POSTING}"))
    assert events[0] == {
        "type": "tool_call",
        "tool": "tailor_resume",
        "title": "Tailoring your resume",
        "args": {"include_cover_letter": False},
    }
    assert planner["calls"] == 1
    assert tailoring["saved"]["job_description"] == POSTING.strip()


def test_selected_tool_is_handed_to_the_planner(planner, monkeypatch):
    seen = {}

    async def fake_completion(_client, **kwargs):
        seen["messages"] = kwargs["messages"]
        return json.dumps({"message": "Here are your stats."}), None

    monkeypatch.setattr(orchestrator, "chat_completion_with_empty_retry", fake_completion)
    run(_collect(message="this week", selected_tool="get_stats"))
    rules = [m["content"] for m in seen["messages"] if m["role"] == "system"]
    assert any("get_stats" in r and "picked" in r for r in rules)
    assert "NEVER ask the user to paste their resume" in rules[0]

    run(_collect(message="this week", selected_tool="no_such_tool"))
    assert not any("picked" in m["content"] for m in seen["messages"] if m["role"] == "system")


def test_phase_b_skips_the_cover_letter_call_unless_asked(monkeypatch):
    from app.services import job_match_service

    calls = []

    async def fake_call(*, observe_name, **_kwargs):
        calls.append(observe_name)
        if "cover" in observe_name:
            return {"cover_letter": {"body": "Dear team"}}
        return {"tailored_resume": None}

    monkeypatch.setattr(job_match_service, "_call_openai_json", fake_call)
    resume, letter = run(
        job_match_service.generate_tailored_content_phase_b(
            JD, "Backend engineer with Python and Go.", include_cover_letter=False
        )
    )
    assert letter is None
    assert not any("cover" in c for c in calls)

    calls.clear()
    _resume, letter = run(
        job_match_service.generate_tailored_content_phase_b(JD, "Backend engineer with Python and Go.")
    )
    assert letter is not None
    assert "phase_b_cover_letter" in calls


def test_saved_posting_drops_the_request_line():
    assert catalog.posting_without_request(f"generate the tailored resume for this job description\n\n{JD}") == JD
    assert catalog.posting_without_request(f"{JD}\n\nPlease tailor my resume and add a cover letter.") == JD
    assert catalog.posting_without_request(JD) == JD


def test_pasted_recruiter_email_names_the_company():
    from app.services.pasted_job_scoring import _clean_span, _recruiter_company

    assert _recruiter_company("Hi There, Its Arun from Acme Robotics. Senior Backend Engineer") == "Acme Robotics"
    assert _recruiter_company("I'm Priya at Bank of America\nWe need") == "Bank of America"
    assert _recruiter_company("We are looking for someone from any background") is None
    assert _clean_span("- Acme Robotics") == "Acme Robotics"


def test_same_posting_updates_its_document_but_same_title_does_not(monkeypatch):
    from app.storage import resume_document_repository as repo_mod
    from app.models.resume_design_schemas import ResumeDesign

    class Doc:
        def __init__(self, **kw):
            self.__dict__.update(kw)

    store: list[Doc] = []

    class FakeRepo:
        def __init__(self, _session):
            pass

        async def find_by_job_description_hash(self, user_id, jd_hash):
            return next((d for d in store if d.job_description_hash == jd_hash), None)

        async def list_for_user(self, user_id):
            return list(store)

        async def create(self, **kw):
            doc = Doc(id=f"d{len(store)}", **kw)
            store.append(doc)
            return doc

    monkeypatch.setattr(repo_mod, "ResumeDocumentRepository", FakeRepo)
    design = ResumeDesign.model_validate({})

    async def save(jd):
        return await resume_design_service._upsert_tailored_library_doc(
            None,
            user_id="u",
            name="Engineer - Vaco",
            company="Vaco",
            job_title="Engineer",
            design=design,
            job_description=jd,
            origin="assistant",
        )

    first = run(save(JD))
    again = run(save(f"  {JD.upper()}\n"))
    other = run(save(JD + " Also Rust."))
    assert again is first
    assert other is not first
    assert len(store) == 2
    assert first.job_description_hash == resume_design_service.job_description_hash(JD)
