import asyncio
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

# Avoid pulling FastAPI/auth stack when unit-testing dedup services.
_ws_stub = MagicMock()
_ws_stub.publish_ws_event = AsyncMock()
sys.modules.setdefault("app.api.websocket", _ws_stub)

# Stub Google Sheets deps when gspread is not installed in the test interpreter.
if "gspread" not in sys.modules:
    _gspread_stub = MagicMock()
    _gspread_stub.exceptions.APIError = type("APIError", (Exception,), {})
    _gspread_stub.exceptions.SpreadsheetNotFound = type("SpreadsheetNotFound", (Exception,), {})
    sys.modules.setdefault("gspread", _gspread_stub)

if "google.oauth2.service_account" not in sys.modules:
    _google_oauth = MagicMock()
    _google_oauth.Credentials = MagicMock()
    _google_pkg = MagicMock()
    _google_pkg.oauth2.service_account = _google_oauth
    sys.modules.setdefault("google", _google_pkg)
    sys.modules.setdefault("google.oauth2", _google_pkg.oauth2)
    sys.modules.setdefault("google.oauth2.service_account", _google_oauth)


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()
