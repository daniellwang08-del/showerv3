"""TLS fingerprint impersonation utilities using curl_cffi.

Use these helpers when a site blocks standard Python HTTP clients based on
TLS/JA3 fingerprinting but doesn't require full browser rendering.
"""

import logging
from typing import Optional

logger = logging.getLogger(__name__)


def fetch_with_browser_tls(
    url: str,
    impersonate: str = "chrome",
    headers: Optional[dict] = None,
    timeout: int = 15,
) -> Optional[bytes]:
    """Fetch a URL mimicking a real browser's TLS fingerprint."""
    try:
        from curl_cffi import requests as cffi_requests

        resp = cffi_requests.get(
            url,
            impersonate=impersonate,
            headers=headers or {},
            timeout=timeout,
        )
        resp.raise_for_status()
        return resp.content
    except ImportError:
        logger.error("curl_cffi not installed — pip install curl_cffi")
        return None
    except Exception as e:
        logger.error("TLS-impersonated fetch failed for %s: %s", url, e)
        return None


def fetch_json_with_browser_tls(
    url: str,
    impersonate: str = "chrome",
    headers: Optional[dict] = None,
    timeout: int = 15,
) -> Optional[dict]:
    """Fetch a JSON API endpoint mimicking a real browser's TLS fingerprint."""
    try:
        from curl_cffi import requests as cffi_requests

        default_headers = {"Accept": "application/json"}
        if headers:
            default_headers.update(headers)
        resp = cffi_requests.get(
            url,
            impersonate=impersonate,
            headers=default_headers,
            timeout=timeout,
        )
        resp.raise_for_status()
        return resp.json()
    except ImportError:
        logger.error("curl_cffi not installed — pip install curl_cffi")
        return None
    except Exception as e:
        logger.error("TLS-impersonated JSON fetch failed for %s: %s", url, e)
        return None
