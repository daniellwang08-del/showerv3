"""Issue reports: attachment checks, validation, creation, admin triage, and safe serving."""

from __future__ import annotations

import io
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.datastructures import Headers, UploadFile

from app.api import issue_routes
from app.models.database import IssueReport, IssueReportAttachment
from app.services import issue_service as svc
from app.services.issue_service import IssueError, Upload

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
GIF = b"GIF89a" + b"\x00" * 64
WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 64
PDF = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n"
DOCX = b"PK\x03\x04" + b"\x00" * 64
DOC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 64
DESC = "Autofill left the resume field empty on Workable."


# ---------------------------------------------------------------- attachments


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("resume.pdf", "resume.pdf"),
        ("C:\\Users\\pat\\Desktop\\My resume.pdf", "My resume.pdf"),
        ("../../etc/passwd", "passwd"),
        ('bad"<name>|?.png', "badname.png"),
        ("line\r\nbreak.txt", "linebreak.txt"),
        ("", "attachment"),
        (None, "attachment"),
        ("...", "attachment"),
    ],
)
def test_clean_filename(raw, expected):
    assert svc.clean_filename(raw) == expected


def test_clean_filename_keeps_extension_when_truncating():
    name = svc.clean_filename("a" * 300 + ".pdf")
    assert len(name) <= 200
    assert name.endswith(".pdf")


@pytest.mark.parametrize(
    "data, kind", [(PNG, "png"), (JPEG, "jpeg"), (GIF, "gif"), (WEBP, "webp"), (PDF, None), (b"hello", None)]
)
def test_image_type_sniffs_magic_bytes(data, kind):
    assert svc.image_type(data) == kind


def test_images_are_typed_by_content_not_name():
    shot = svc.check_attachment("image.png", PNG)
    assert (shot.kind, shot.content_type, shot.filename) == ("image", "image/png", "image.png")
    # A JPEG named .png keeps its name (still an image extension) but gets the real type.
    jpg = svc.check_attachment("photo.png", JPEG)
    assert (jpg.kind, jpg.content_type) == ("image", "image/jpeg")
    # An image without an image extension gets one, so downloads open correctly.
    named = svc.check_attachment("clipboard", WEBP)
    assert (named.filename, named.content_type) == ("clipboard.webp", "image/webp")


def test_documents_need_matching_content():
    assert svc.check_attachment("resume.pdf", PDF).content_type == "application/pdf"
    assert svc.check_attachment("resume", PDF).filename == "resume.pdf"
    assert svc.check_attachment("cv.docx", DOCX).content_type.endswith("wordprocessingml.document")
    assert svc.check_attachment("cv.doc", DOC).content_type == "application/msword"
    assert svc.check_attachment("cv.rtf", b"{\\rtf1 hello}").content_type == "application/rtf"
    assert svc.check_attachment("logs.zip", DOCX).content_type == "application/zip"
    with pytest.raises(IssueError, match="not a supported file"):
        svc.check_attachment("cv.pdf", b"<html><script>alert(1)</script></html>")
    with pytest.raises(IssueError, match="not a supported file"):
        svc.check_attachment("tool.exe", b"MZ\x90\x00" + b"\x00" * 64)
    # A zip pretending to be an unknown type is refused.
    with pytest.raises(IssueError, match="not a supported file"):
        svc.check_attachment("app.apk", DOCX)


def test_text_files_are_served_as_plain_text():
    log = svc.check_attachment("console.log", "Error: boom \u2713\n".encode())
    assert (log.kind, log.content_type) == ("file", "text/plain; charset=utf-8")
    # Text that is really HTML is still served as plain text, never as HTML.
    assert svc.check_attachment("notes.txt", b"<script>x</script>").content_type.startswith("text/plain")
    with pytest.raises(IssueError):
        svc.check_attachment("page.html", b"<script>x</script>")
    with pytest.raises(IssueError):
        svc.check_attachment("data.txt", b"abc\x00def")
    with pytest.raises(IssueError):
        svc.check_attachment("data.txt", b"\xff\xfe\xfa bad utf8 " * 3)


def test_text_cut_mid_character_at_sample_boundary_is_still_text():
    data = b"a" * 65535 + "\u00e9".encode()  # 2-byte char split by the 64 KiB sample
    assert svc.check_attachment("big.log", data).kind == "file"


def test_empty_and_oversized_files_are_refused():
    with pytest.raises(IssueError, match="is empty"):
        svc.check_attachment("a.png", b"")
    with pytest.raises(IssueError, match="larger than 10 MB"):
        svc.check_attachment("big.pdf", b"%PDF-" + b"0" * svc.MAX_FILE_BYTES)


# ---------------------------------------------------------------- validation


def test_validate_report_cleans_fields_and_derives_title():
    title, desc, cat, checked = svc.validate_report(
        title="", description="  First line here\r\nSecond line \x00 ", category="AUTOFILL", uploads=[]
    )
    assert title == "First line here"
    assert desc == "First line here\nSecond line"
    assert cat == "autofill"
    assert checked == []

    long_first = "x" * 400
    title, *_ = svc.validate_report(title=None, description=long_first, category=None, uploads=[])
    assert len(title) == svc.TITLE_MAX and title.endswith("...")

    title, *_ = svc.validate_report(title="  Two   spaces\n", description=DESC, category="bug", uploads=[])
    assert title == "Two spaces"


@pytest.mark.parametrize(
    "kwargs, message",
    [
        ({"description": "short"}, "at least 10 characters"),
        ({"description": "   " + "a" * 5 + "   "}, "at least 10 characters"),
        ({"description": "a" * (svc.DESCRIPTION_MAX + 1)}, "under 10,000"),
        ({"category": "feature-request"}, "Pick what the issue is about"),
        ({"uploads": [Upload("a.png", PNG)] * (svc.MAX_ATTACHMENTS + 1)}, "at most 10 files"),
        ({"uploads": [Upload(f"{i}.pdf", b"%PDF-" + b"0" * (9 * 1024 * 1024)) for i in range(3)]}, "more than 25 MB"),
        ({"uploads": [Upload("a.png", PNG), Upload("evil.svg", b"<svg onload=alert(1)>")]}, "evil.svg is not a supported"),
    ],
)
def test_validate_report_rejects_with_user_facing_messages(kwargs, message):
    base = {"title": "", "description": DESC, "category": "bug", "uploads": []}
    with pytest.raises(IssueError, match=message):
        svc.validate_report(**{**base, **kwargs})


def test_clean_url_and_context():
    assert svc._clean_url("https://apply.workable.com/x") == "https://apply.workable.com/x"
    assert svc._clean_url("javascript:alert(1)") is None
    assert svc._clean_url("chrome-extension://abc/panel.html") is None
    assert svc._clean_url("") is None
    ctx = svc._clean_context({"Extension Version": "2.4.2", "ok": True, "n": 3, "x": {"deep": 1}, "": "drop", "big": "y" * 900})
    assert ctx == {"extensionversion": "2.4.2", "ok": True, "n": 3, "x": "{'deep': 1}", "big": "y" * 500}
    assert svc._clean_context("not a dict") is None
    assert svc._clean_context({}) is None


# ---------------------------------------------------------------- fake session


class _Result:
    def __init__(self, value=None, rows=None):
        self._value, self._rows = value, rows or []

    def scalar_one(self):
        return self._value

    def scalar_one_or_none(self):
        return self._value

    def scalars(self):
        return iter(self._rows)

    def all(self):
        return self._rows


class FakeSession:
    """Just enough of AsyncSession for create/update/attachment lookups."""

    def __init__(self, recent: int = 0):
        self.recent = recent
        self.reports: dict[str, IssueReport] = {}
        self.attachments: list[IssueReportAttachment] = []
        self.users: dict[str, SimpleNamespace] = {}
        self.next_number = 41
        self.commits = 0

    def add(self, obj):
        if isinstance(obj, IssueReport):
            self.reports[obj.id] = obj

    def add_all(self, objs):
        self.attachments.extend(objs)

    async def flush(self):
        return None

    async def commit(self):
        self.commits += 1

    async def refresh(self, obj):
        if isinstance(obj, IssueReport) and obj.number is None:
            self.next_number += 1
            obj.number = self.next_number

    async def get(self, model, key):
        return self.reports.get(key) if model is IssueReport else None

    async def execute(self, stmt):
        sql = str(stmt)
        params = stmt.compile().params
        if "count(" in sql:
            return _Result(self.recent)
        if "FROM issue_report_attachments" in sql:
            want = {v for v in params.values() if isinstance(v, str)}
            for v in params.values():
                if isinstance(v, (list, tuple)):
                    want |= set(v)
            if "attachments.id =" in sql:
                hit = [a for a in self.attachments if a.id in want and a.report_id in want]
                return _Result(hit[0] if hit else None)
            return _Result(rows=[a for a in self.attachments if a.report_id in want])
        if "FROM users" in sql:
            return _Result(rows=list(self.users.values()))
        raise AssertionError(f"unexpected query: {sql}")


def _patch_people(monkeypatch):
    async def people(session, ids):
        return {i: session.users[i] for i in ids if i and i in session.users}

    monkeypatch.setattr(svc, "_people", people)
    import app.services.report_share as rs

    monkeypatch.setattr(rs, "display_name", lambda u: u.name or u.email)


# ---------------------------------------------------------------- service


@pytest.mark.asyncio
async def test_create_report_stores_attachments_in_order_with_safe_types():
    s = FakeSession()
    out = await svc.create_report(
        s,
        "u1",
        title="",
        description=DESC,
        category="autofill",
        page_url="https://apply.workable.com/acme/j/1/apply",
        page_title="Apply - Acme",
        context={"extension_version": "2.4.2", "job_id": "j1"},
        uploads=[Upload("image.png", PNG), Upload("My resume.pdf", PDF)],
    )
    assert out["number"] == 42
    assert out["status"] == "open"
    assert out["title"] == DESC
    assert out["page_url"].startswith("https://apply.workable.com/")
    assert [(a["kind"], a["filename"], a["content_type"]) for a in out["attachments"]] == [
        ("image", "image.png", "image/png"),
        ("file", "My resume.pdf", "application/pdf"),
    ]
    assert "context" not in out and "admin_note" not in out  # admin-only fields stay hidden
    stored = s.reports[out["id"]]
    assert stored.user_id == "u1" and stored.context == {"extension_version": "2.4.2", "job_id": "j1"}
    assert [a.position for a in s.attachments] == [0, 1]
    assert s.attachments[1].data == PDF and s.attachments[1].byte_size == len(PDF)


@pytest.mark.asyncio
async def test_create_report_is_rate_limited_per_user():
    s = FakeSession(recent=svc.REPORTS_PER_HOUR)
    with pytest.raises(IssueError, match="a lot of reports"):
        await svc.create_report(s, "u1", title="", description=DESC, category="bug")
    assert s.reports == {}


@pytest.mark.asyncio
async def test_create_report_validates_before_touching_the_database():
    s = FakeSession()
    with pytest.raises(IssueError):
        await svc.create_report(s, "u1", title="", description="short", category="bug")
    assert s.reports == {} and s.attachments == []


async def _seed(s: FakeSession) -> str:
    out = await svc.create_report(
        s, "u1", title="Broken", description=DESC, category="bug", uploads=[Upload("shot.png", PNG)]
    )
    s.users = {
        "u1": SimpleNamespace(id="u1", name="Pat Lee", email="pat@x.io"),
        "a1": SimpleNamespace(id="a1", name="Ada Admin", email="ada@nao.dev"),
    }
    return out["id"]


@pytest.mark.asyncio
async def test_admin_update_records_who_changed_the_status(monkeypatch):
    _patch_people(monkeypatch)
    s = FakeSession()
    rid = await _seed(s)

    out = await svc.admin_update(s, "a1", rid, status="in_progress")
    assert out["status"] == "in_progress"
    assert out["status_changed_by"] == {"id": "a1", "name": "Ada Admin", "email": "ada@nao.dev"}
    assert out["reporter"]["email"] == "pat@x.io"
    changed_at = s.reports[rid].status_changed_at
    assert changed_at is not None

    # A note alone leaves the status history untouched.
    out = await svc.admin_update(s, "a2", rid, admin_note="  Known Workable change.  ")
    assert out["admin_note"] == "Known Workable change."
    assert s.reports[rid].status_changed_by_user_id == "a1"
    assert s.reports[rid].status_changed_at == changed_at

    out = await svc.admin_update(s, "a1", rid, admin_note="")
    assert out["admin_note"] is None

    with pytest.raises(IssueError, match="Unknown status"):
        await svc.admin_update(s, "a1", rid, status="wontfix")
    with pytest.raises(svc.IssueNotFound):
        await svc.admin_update(s, "a1", "missing", status="closed")


@pytest.mark.asyncio
async def test_attachments_are_only_for_the_reporter_or_an_admin():
    s = FakeSession()
    rid = await _seed(s)
    aid = s.attachments[0].id

    mine = await svc.attachment_for(s, rid, aid, user_id="u1", is_admin=False)
    assert mine.data == PNG
    admin = await svc.attachment_for(s, rid, aid, user_id="a1", is_admin=True)
    assert admin.id == aid
    with pytest.raises(svc.IssueNotFound):
        await svc.attachment_for(s, rid, aid, user_id="someone-else", is_admin=False)
    with pytest.raises(svc.IssueNotFound):
        await svc.attachment_for(s, rid, "other-attachment", user_id="u1", is_admin=False)


# ---------------------------------------------------------------- routes


def _upload(name: str, data: bytes, content_type: str = "application/octet-stream") -> UploadFile:
    return UploadFile(io.BytesIO(data), filename=name, headers=Headers({"content-type": content_type}))


def _route_session(monkeypatch, s: FakeSession):
    @asynccontextmanager
    async def get_session():
        yield s

    monkeypatch.setattr(issue_routes, "get_session", get_session)


@pytest.mark.asyncio
async def test_create_route_reads_multipart_files_and_commits(monkeypatch):
    s = FakeSession()
    _route_session(monkeypatch, s)
    out = await issue_routes.create_issue(
        description=DESC,
        title="Resume missing",
        category="autofill",
        page_url="https://jobs.lever.co/acme/1/apply",
        page_title="Lever",
        context=json.dumps({"panel_view": "job"}),
        source="extension",
        files=[_upload("C:\\fakepath\\image.png", PNG, "image/png"), _upload("cv.pdf", PDF, "application/pdf")],
        current_user={"user_id": "u1"},
    )
    assert s.commits == 1
    assert out["title"] == "Resume missing"
    assert [a["filename"] for a in out["attachments"]] == ["image.png", "cv.pdf"]
    assert s.reports[out["id"]].context == {"panel_view": "job"}


@pytest.mark.asyncio
async def test_create_route_turns_problems_into_400s(monkeypatch):
    s = FakeSession()
    _route_session(monkeypatch, s)
    call = dict(
        title="",
        category="bug",
        page_url="",
        page_title="",
        context="{not json",
        source="evil",
        current_user={"user_id": "u1"},
    )
    with pytest.raises(HTTPException) as e:
        await issue_routes.create_issue(description=DESC, files=[_upload("x.exe", b"MZ" + b"\x00" * 40)], **call)
    assert e.value.status_code == 400 and "x.exe is not a supported file" in e.value.detail

    with pytest.raises(HTTPException) as e:
        await issue_routes.create_issue(
            description=DESC, files=[_upload("big.pdf", b"%PDF-" + b"0" * svc.MAX_FILE_BYTES)], **call
        )
    assert e.value.status_code == 400 and "larger than 10 MB" in e.value.detail
    assert s.commits == 0

    # Bad context JSON and an unknown source do not block the report.
    out = await issue_routes.create_issue(description=DESC, files=[], **call)
    assert out["source"] == "extension"
    assert s.reports[out["id"]].context is None


@pytest.mark.asyncio
async def test_attachment_route_serves_images_inline_and_files_as_downloads(monkeypatch):
    s = FakeSession()
    _route_session(monkeypatch, s)
    out = await svc.create_report(
        s,
        "u1",
        title="",
        description=DESC,
        category="bug",
        uploads=[Upload("shot.png", PNG), Upload("r\u00e9sum\u00e9.pdf", PDF), Upload("console.log", b"<script>x</script>")],
    )
    rid = out["id"]
    img, pdf, log = (a["id"] for a in out["attachments"])
    owner = {"user_id": "u1", "is_admin": False}

    r = await issue_routes.get_attachment(rid, img, download=False, current_user=owner)
    assert r.body == PNG
    assert r.media_type == "image/png"
    assert r.headers["content-disposition"].startswith('inline; filename="shot.png"')
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in r.headers["content-security-policy"]

    r = await issue_routes.get_attachment(rid, img, download=True, current_user=owner)
    assert r.headers["content-disposition"].startswith("attachment;")

    r = await issue_routes.get_attachment(rid, pdf, download=False, current_user={"user_id": "a1", "is_admin": True})
    assert r.headers["content-disposition"] == (
        "attachment; filename=\"rsum.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"
    )

    r = await issue_routes.get_attachment(rid, log, download=False, current_user=owner)
    assert r.media_type.startswith("text/plain")
    assert r.headers["content-disposition"].startswith("attachment;")

    with pytest.raises(HTTPException) as e:
        await issue_routes.get_attachment(rid, img, download=False, current_user={"user_id": "u2", "is_admin": False})
    assert e.value.status_code == 404


def test_routes_are_registered_with_admin_guards():
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(issue_routes.router, prefix="/api/v1")
    paths = {(r.path, tuple(sorted(r.methods))) for r in app.routes if hasattr(r, "methods")}
    for path, method in [
        ("/api/v1/issues", "POST"),
        ("/api/v1/issues", "GET"),
        ("/api/v1/issues/options", "GET"),
        ("/api/v1/issues/admin", "GET"),
        ("/api/v1/issues/admin/{report_id}", "GET"),
        ("/api/v1/issues/admin/{report_id}", "PATCH"),
        ("/api/v1/issues/{report_id}/attachments/{attachment_id}", "GET"),
    ]:
        assert (path, (method,)) in paths, (path, method)

    from app.api.routes import require_admin

    for route in issue_routes.router.routes:
        guarded = any(d.call is require_admin for d in route.dependant.dependencies)
        assert guarded == ("/admin" in route.path), route.path
