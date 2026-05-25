"""Utility for probing sites to discover hidden JSON API endpoints.

Used during spider development: run against a target site to find XHR/fetch
endpoints that return structured job data, so we can hit them directly
instead of rendering pages with Playwright.
"""

import json
import logging

import httpx

logger = logging.getLogger(__name__)

COMMON_API_PATTERNS = [
    "/api/jobs",
    "/api/v1/jobs",
    "/api/v2/jobs",
    "/api/search",
    "/api/v1/search",
    "/graphql",
    "/_next/data",
    "/search.json",
    "/jobs.json",
]


def probe_api_endpoints(base_url: str, timeout: float = 10.0) -> list[dict]:
    """Try common API endpoint patterns and report which ones respond with JSON."""
    results = []
    with httpx.Client(
        timeout=timeout,
        follow_redirects=True,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json, text/html",
        },
    ) as client:
        for pattern in COMMON_API_PATTERNS:
            url = f"{base_url.rstrip('/')}{pattern}"
            try:
                resp = client.get(url)
                content_type = resp.headers.get("content-type", "")
                is_json = "json" in content_type
                if is_json:
                    try:
                        body = resp.json()
                        results.append({
                            "url": url,
                            "status": resp.status_code,
                            "content_type": content_type,
                            "is_json": True,
                            "sample_keys": list(body.keys()) if isinstance(body, dict) else f"array[{len(body)}]",
                        })
                    except json.JSONDecodeError:
                        pass
                logger.debug("%s -> %s (%s)", url, resp.status_code, content_type)
            except httpx.RequestError as e:
                logger.debug("%s -> error: %s", url, e)
    return results


def probe_with_curl_cffi(url: str, impersonate: str = "chrome") -> dict | None:
    """Probe a URL using curl_cffi for TLS fingerprint impersonation.

    Returns response info if successful, None otherwise.
    """
    try:
        from curl_cffi import requests as cffi_requests

        resp = cffi_requests.get(url, impersonate=impersonate, timeout=10)
        content_type = resp.headers.get("content-type", "")
        return {
            "url": url,
            "status": resp.status_code,
            "content_type": content_type,
            "is_json": "json" in content_type,
            "body_length": len(resp.content),
        }
    except Exception as e:
        logger.debug("curl_cffi probe failed for %s: %s", url, e)
        return None
