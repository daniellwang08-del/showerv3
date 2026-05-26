import asyncio
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

# Avoid pulling FastAPI/auth stack when unit-testing dedup services.
_ws_stub = MagicMock()
_ws_stub.publish_ws_event = AsyncMock()
sys.modules.setdefault("app.api.websocket", _ws_stub)


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()
