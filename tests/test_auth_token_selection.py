"""Bearer must win over a leftover dashboard cookie (extension sign-in)."""

from starlette.requests import Request

from app.api.routes import _extract_bearer_token, _request_access_token


def _request(headers: list[tuple[bytes, bytes]]) -> Request:
    return Request(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/",
            "raw_path": b"/",
            "query_string": b"",
            "headers": headers,
            "client": ("127.0.0.1", 123),
            "server": ("test", 80),
        }
    )


def test_bearer_wins_over_cookie():
    req = _request(
        [
            (b"authorization", b"Bearer extension-token"),
            (b"cookie", b"access_token=stale-cookie-token"),
        ]
    )
    assert _extract_bearer_token(req) == "extension-token"
    assert _request_access_token(req) == "extension-token"


def test_cookie_used_when_no_bearer():
    req = _request([(b"cookie", b"access_token=web-cookie-token")])
    assert _extract_bearer_token(req) is None
    assert _request_access_token(req) == "web-cookie-token"


def test_missing_credentials():
    req = _request([])
    assert _request_access_token(req) is None
