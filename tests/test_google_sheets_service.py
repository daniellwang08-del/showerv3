"""Unit tests for Google Sheets service helpers."""

import json
from pathlib import Path

import gspread
import pytest

from app.services import google_sheets_service as gs


def test_extract_spreadsheet_id_from_url():
    url = "https://docs.google.com/spreadsheets/d/abc123XYZ/edit#gid=0"
    assert gs._extract_spreadsheet_id(url) == "abc123XYZ"


def test_extract_spreadsheet_id_invalid():
    assert gs._extract_spreadsheet_id("https://example.com/not-a-sheet") is None


def test_classify_spreadsheet_error_permission():
    err = gspread.exceptions.APIError({"code": 403, "message": "Forbidden"})
    err.response = type("R", (), {"status_code": 403})()
    mapped = gs.classify_spreadsheet_error(err, service_account_email="bot@example.com")
    assert isinstance(mapped, gs.SpreadsheetAccessError)
    assert mapped.code == "permission_denied"
    assert "bot@example.com" in str(mapped)


def test_classify_spreadsheet_error_not_found():
    mapped = gs.classify_spreadsheet_error(
        gspread.exceptions.SpreadsheetNotFound("missing"),
        service_account_email="bot@example.com",
    )
    assert mapped.code == "not_found"


def test_get_server_status_without_credentials(tmp_path, monkeypatch):
    missing = tmp_path / "missing.json"
    monkeypatch.setattr(gs, "_credentials_path", lambda: missing)
    status = gs.get_server_status()
    assert status["server_configured"] is False
    assert status["service_account_email"] is None


def test_get_server_status_with_credentials(tmp_path, monkeypatch):
    creds = tmp_path / "creds.json"
    creds.write_text(
        json.dumps({"client_email": "sheet-bot@project.iam.gserviceaccount.com"}),
        encoding="utf-8",
    )
    monkeypatch.setattr(gs, "_credentials_path", lambda: creds)
    status = gs.get_server_status()
    assert status["server_configured"] is True
    assert status["service_account_email"] == "sheet-bot@project.iam.gserviceaccount.com"


@pytest.mark.asyncio
async def test_verify_spreadsheet_invalid_url():
    with pytest.raises(ValueError, match="Could not extract spreadsheet ID"):
        await gs.verify_spreadsheet("https://example.com/nope")


@pytest.mark.asyncio
async def test_verify_spreadsheet_missing_credentials(tmp_path, monkeypatch):
    missing = tmp_path / "missing.json"
    monkeypatch.setattr(gs, "_credentials_path", lambda: missing)
    with pytest.raises(FileNotFoundError):
        await gs.verify_spreadsheet(
            "https://docs.google.com/spreadsheets/d/abc123/edit",
        )


@pytest.mark.asyncio
async def test_verify_spreadsheet_success(tmp_path, monkeypatch):
    creds = tmp_path / "creds.json"
    creds.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(gs, "_credentials_path", lambda: creds)
    monkeypatch.setattr(gs, "get_service_account_email", lambda: "bot@example.com")

    async def fake_to_thread(fn, *args, **kwargs):
        return fn(*args, **kwargs)

    monkeypatch.setattr(gs.asyncio, "to_thread", fake_to_thread)
    monkeypatch.setattr(gs, "_sync_get_all_tabs", lambda _sid: ["Tab A", "Tab B"])

    result = await gs.verify_spreadsheet(
        "https://docs.google.com/spreadsheets/d/sheet-id-1/edit",
    )
    assert result["tab_count"] == 2
    assert result["tabs"] == ["Tab A", "Tab B"]
    assert result["spreadsheet_id"] == "sheet-id-1"


def test_clamp_auto_post_threshold():
    assert gs._clamp_auto_post_threshold(-5) == 0
    assert gs._clamp_auto_post_threshold(150) == 100
    assert gs._clamp_auto_post_threshold(75) == 75


def test_resolve_worksheet_name_exact_and_whitespace():
    available = ["CHELL(Kevin)", " Timmy(Zeyu)"]
    assert gs._resolve_worksheet_name("CHELL(Kevin)", available) == "CHELL(Kevin)"
    assert gs._resolve_worksheet_name("Timmy(Zeyu)", available) == " Timmy(Zeyu)"
    assert gs._resolve_worksheet_name(" Timmy(Zeyu) ", available) == " Timmy(Zeyu)"
    assert gs._resolve_worksheet_name("Timi(Zeyu)", available) is None


def test_canonicalize_tab_groups_rewrites_whitespace_mismatch():
    available = [" Timmy(Zeyu)", "Tab A"]
    groups, warnings = gs._canonicalize_tab_groups([["Timmy(Zeyu)", "Tab A"]], available)
    assert groups == [[" Timmy(Zeyu)", "Tab A"]]
    assert any("matched spreadsheet tab" in w for w in warnings)


def test_canonicalize_tab_groups_unknown_tab():
    available = [" Timmy(Zeyu)"]
    groups, warnings = gs._canonicalize_tab_groups([["Timi(Zeyu)"]], available)
    assert groups == [["Timi(Zeyu)"]]
    assert any("was not found" in w for w in warnings)


def test_sync_write_rows_uses_batch_update(monkeypatch):
    class FakeWorksheet:
        def __init__(self, title: str):
            self.title = title

    class FakeSpreadsheet:
        def __init__(self):
            self.batch_calls: list[dict] = []

        def worksheets(self):
            return [FakeWorksheet(" Timmy(Zeyu)")]

        def values_batch_update(self, payload):
            self.batch_calls.append(payload)

    fake_sh = FakeSpreadsheet()
    monkeypatch.setattr(gs, "_open_spreadsheet", lambda _sid: fake_sh)
    monkeypatch.setattr(gs, "_api_call_with_retry", lambda fn, *args, **kwargs: fn(*args, **kwargs))

    outcomes = gs._sync_write_rows(
        "sheet-id",
        [("Timmy(Zeyu)", 10, "https://example.com/job/1")],
    )
    assert outcomes == [("Timmy(Zeyu)", 10, True)]
    assert len(fake_sh.batch_calls) == 1
    assert fake_sh.batch_calls[0]["data"][0]["range"] == "' Timmy(Zeyu)'!B10:C10"


def test_sync_write_rows_unknown_tab():
    class FakeSpreadsheet:
        def worksheets(self):
            return []

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(gs, "_open_spreadsheet", lambda _sid: FakeSpreadsheet())
    monkeypatch.setattr(gs, "_api_call_with_retry", lambda fn, *args, **kwargs: fn(*args, **kwargs))
    outcomes = gs._sync_write_rows("sheet-id", [("Missing", 5, "https://x.test")])
    assert outcomes == [("Missing", 5, False)]
    monkeypatch.undo()


@pytest.mark.asyncio
async def test_update_auto_post_threshold_success(monkeypatch):
    class FakeConfig:
        auto_post_threshold = 75
        tab_groups = [["Tab A"]]
        spreadsheet_url = "https://docs.google.com/spreadsheets/d/x/edit"

    config = FakeConfig()

    class FakeResult:
        def scalar_one_or_none(self):
            return config

    class FakeSession:
        async def execute(self, _stmt):
            return FakeResult()

        async def flush(self):
            return None

    class FakeCtx:
        async def __aenter__(self):
            return FakeSession()

        async def __aexit__(self, *args):
            return False

    monkeypatch.setattr(gs, "get_session", lambda: FakeCtx())
    updated = await gs.update_auto_post_threshold("user-1", 82)
    assert updated.auto_post_threshold == 82


@pytest.mark.asyncio
async def test_update_auto_post_threshold_not_configured(monkeypatch):
    class FakeResult:
        def scalar_one_or_none(self):
            return None

    class FakeSession:
        async def execute(self, _stmt):
            return FakeResult()

    class FakeCtx:
        async def __aenter__(self):
            return FakeSession()

        async def __aexit__(self, *args):
            return False

    monkeypatch.setattr(gs, "get_session", lambda: FakeCtx())
    with pytest.raises(ValueError, match="not configured"):
        await gs.update_auto_post_threshold("user-1", 70)


def test_classify_spreadsheet_error_generic_message():
    mapped = gs.classify_spreadsheet_error(Exception("403 forbidden"))
    assert mapped.code == "permission_denied"
