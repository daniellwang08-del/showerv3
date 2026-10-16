"""Resume Studio AI chat: JD resolution and per-resume history persistence."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.api import routes as routes_mod
from app.models.resume_ai_schemas import ResumeAiChatMessage, ResumeAiChatResponse


class _SessionCtx:
    def __init__(self, repo):
        self.repo = repo

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def add(self, *_a, **_k):
        return None

    async def commit(self):
        return None

    async def flush(self):
        return None


@pytest.mark.asyncio
async def test_resolve_job_description_prefers_client_then_session_then_doc(monkeypatch):
    calls = {"n": 0}

    class Repo:
        async def get_session(self, user_id, resume_id):
            return SimpleNamespace(last_job_description="Session JD")

        async def get_owned_resume(self, user_id, resume_id):
            return SimpleNamespace(job_description="Document JD")

    monkeypatch.setattr(
        routes_mod,
        "get_session",
        lambda: _SessionCtx(None),
    )

    # Patch repository construction inside the helper by stubbing the module import target.
    import app.storage.resume_ai_chat_repository as repo_mod

    monkeypatch.setattr(repo_mod, "ResumeAiChatRepository", lambda session: Repo())

    assert (
        await routes_mod._resolve_resume_ai_job_description("u1", "r1", "  Client JD  ")
        == "Client JD"
    )
    assert await routes_mod._resolve_resume_ai_job_description("u1", "r1", None) == "Session JD"

    class RepoDocOnly:
        async def get_session(self, user_id, resume_id):
            return None

        async def get_owned_resume(self, user_id, resume_id):
            return SimpleNamespace(job_description="Document JD")

    monkeypatch.setattr(repo_mod, "ResumeAiChatRepository", lambda session: RepoDocOnly())
    assert await routes_mod._resolve_resume_ai_job_description("u1", "r1", None) == "Document JD"
    assert await routes_mod._resolve_resume_ai_job_description("u1", None, None) is None
    calls["n"] += 1
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_persist_resume_ai_turn_writes_trimmed_history(monkeypatch):
    saved = {}

    class Repo:
        async def get_owned_resume(self, user_id, resume_id):
            return SimpleNamespace(id=resume_id)

        async def upsert_messages(self, user_id, resume_id, messages, last_job_description):
            saved["payload"] = {
                "user_id": user_id,
                "resume_id": resume_id,
                "messages": messages,
                "last_job_description": last_job_description,
            }
            return SimpleNamespace(id="s1")

    import app.storage.resume_ai_chat_repository as repo_mod

    monkeypatch.setattr(routes_mod, "get_session", lambda: _SessionCtx(None))
    monkeypatch.setattr(repo_mod, "ResumeAiChatRepository", lambda session: Repo())

    await routes_mod._persist_resume_ai_turn(
        "u1",
        "r1",
        [
            ResumeAiChatMessage(role="user", content="Tailor this"),
            ResumeAiChatMessage(role="assistant", content="Done."),
        ],
        "JD text",
    )
    assert saved["payload"]["user_id"] == "u1"
    assert saved["payload"]["resume_id"] == "r1"
    assert saved["payload"]["last_job_description"] == "JD text"
    assert saved["payload"]["messages"] == [
        {"role": "user", "content": "Tailor this"},
        {"role": "assistant", "content": "Done."},
    ]


@pytest.mark.asyncio
async def test_get_resume_ai_chat_context_shapes_response(monkeypatch):
    class Repo:
        async def get_owned_resume(self, user_id, resume_id):
            return SimpleNamespace(
                id=resume_id,
                name="Acme resume",
                source="tailored",
                origin="documents",
                job_description="Need Python",
                job_title="Engineer",
                company="Acme",
                match_score=70,
                design={
                    "theme_id": "classic",
                    "content": {
                        "name_first": "Ada",
                        "name_last": "Lovelace",
                        "profile_summary": "Builder",
                        "technical_skills": [],
                        "work_experience": [],
                        "education": [],
                        "certificates": [],
                        "name_middle": "",
                        "title": "",
                        "email": "",
                        "phone_country_code": "",
                        "phone_number": "",
                        "location": "",
                        "linkedin_url": "",
                        "github_url": "",
                    },
                },
            )

        async def get_session(self, user_id, resume_id):
            return SimpleNamespace(
                messages=[
                    {"role": "user", "content": "Hi"},
                    {"role": "assistant", "content": "Hello"},
                    {"role": "system", "content": "skip"},
                ],
                last_job_description="Need Python",
            )

    import app.storage.resume_ai_chat_repository as repo_mod

    monkeypatch.setattr(routes_mod, "get_session", lambda: _SessionCtx(None))
    monkeypatch.setattr(repo_mod, "ResumeAiChatRepository", lambda session: Repo())

    resp = await routes_mod.get_resume_ai_chat_context(
        "r1",
        current_user={"user_id": "u1"},
    )
    assert resp.resume_id == "r1"
    assert resp.company == "Acme"
    assert resp.content["profile_summary"] == "Builder"
    assert [m.model_dump() for m in resp.messages] == [
        {"role": "user", "content": "Hi"},
        {"role": "assistant", "content": "Hello"},
    ]
    assert resp.last_job_description == "Need Python"


@pytest.mark.asyncio
async def test_chat_stream_persists_when_resume_id_present(monkeypatch):
    persisted = {}

    async def fake_resolve(user_id, resume_id, last_job_description):
        return "Resolved JD"

    async def fake_persist(user_id, resume_id, messages, result_job_description):
        persisted["messages"] = [m.model_dump() for m in messages]
        persisted["jd"] = result_job_description

    async def fake_run(user_id, messages, last_job_description, emit=None):
        assert last_job_description == "Resolved JD"
        if emit:
            await emit({"stage": "routing", "label": "Understanding…"})
        return ResumeAiChatResponse(
            reply="All set.",
            intent="chat",
            action="none",
            job_description="Resolved JD",
        )

    class Repo:
        async def get_owned_resume(self, user_id, resume_id):
            return SimpleNamespace(id=resume_id)

    import app.storage.resume_ai_chat_repository as repo_mod
    import app.services.resume_ai_chat_service as chat_svc

    monkeypatch.setattr(routes_mod, "get_session", lambda: _SessionCtx(None))
    monkeypatch.setattr(repo_mod, "ResumeAiChatRepository", lambda session: Repo())
    monkeypatch.setattr(routes_mod, "_resolve_resume_ai_job_description", fake_resolve)
    monkeypatch.setattr(routes_mod, "_persist_resume_ai_turn", fake_persist)
    monkeypatch.setattr(chat_svc, "run_resume_ai_chat", fake_run)

    response = await routes_mod.resume_builder_ai_chat(
        routes_mod.ResumeAiChatRequest(
            resume_id="r1",
            messages=[ResumeAiChatMessage(role="user", content="Hello")],
            last_job_description=None,
        ),
        current_user={"user_id": "u1"},
    )

    chunks: list[str] = []
    async for chunk in response.body_iterator:
        chunks.append(chunk if isinstance(chunk, str) else chunk.decode())
    text = "".join(chunks)
    assert '"stage": "done"' in text or '"stage":"done"' in text
    assert "All set." in text
    assert persisted["jd"] == "Resolved JD"
    assert persisted["messages"][-1]["content"] == "All set."
