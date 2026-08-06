"""Resolve residential proxy URLs for scrapers (esp. RemoteRocketship).

Sources (first non-empty wins for the list; file + inline are merged):
  1. ``SCRAPER_PROXY_LIST_PATH`` — text file, one proxy per line
  2. ``SCRAPER_PROXY_URL`` / ``SCRAPER_PROXY_URLS`` — inline URL(s)
  3. ``SCRAPER_PROXY_HOST`` + ``PORT`` + optional ``USER``/``PASSWORD``
  4. ``PROXY_URL`` when ``PROXY_ENABLED=true`` (shared HTTP-client proxy)

Accepted line / URL formats match ``_parse_proxy_line``.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Iterable, Optional
from urllib.parse import quote

logger = logging.getLogger(__name__)


def _parse_proxy_line(line: str) -> Optional[str]:
    """Normalize a single proxy line into ``http://user:pass@host:port``."""
    line = (line or "").strip()
    if not line or line.startswith("#"):
        return None

    if "://" in line:
        return line

    # host:port:user:pass
    parts_colon = line.split(":")
    if len(parts_colon) == 4 and parts_colon[1].isdigit():
        host, port, user, password = parts_colon
        return (
            f"http://{quote(user, safe='')}:{quote(password, safe='')}@{host}:{port}"
        )

    # host:port<whitespace>user<whitespace>pass
    tokens = line.replace("\t", " ").split()
    if len(tokens) == 3 and ":" in tokens[0]:
        hostport, user, password = tokens
        host, _, port = hostport.partition(":")
        if host and port.isdigit():
            return (
                f"http://{quote(user, safe='')}:{quote(password, safe='')}@{host}:{port}"
            )

    # host:port (no auth)
    if len(parts_colon) == 2 and parts_colon[1].isdigit():
        return f"http://{line}"

    logger.warning("Unrecognized proxy line format: %s", line[:60])
    return None


def _load_proxies_from_file(proxy_path: str) -> list[str]:
    if not proxy_path:
        return []
    p = Path(proxy_path)
    if not p.is_absolute():
        from app.scraper.config import PROJECT_ROOT

        p = PROJECT_ROOT / p
    if not p.exists():
        logger.warning("Proxy list file not found: %s", p)
        return []
    out: list[str] = []
    for raw in p.read_text(encoding="utf-8").splitlines():
        parsed = _parse_proxy_line(raw)
        if parsed:
            out.append(parsed)
    return out


def _split_inline_urls(raw: str) -> list[str]:
    if not raw or not str(raw).strip():
        return []
    text = str(raw).replace("\r\n", "\n").replace("\r", "\n")
    chunks: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if "," in line or ";" in line:
            chunks.extend(re.split(r"[,;]+", line))
        else:
            chunks.append(line)
    out: list[str] = []
    for part in chunks:
        parsed = _parse_proxy_line(part.strip())
        if parsed:
            out.append(parsed)
    return out


def _from_components(
    host: str,
    port: str,
    user: str = "",
    password: str = "",
) -> Optional[str]:
    host = (host or "").strip()
    port = (port or "").strip()
    if not host or not port.isdigit():
        return None
    user = (user or "").strip()
    password = (password or "").strip()
    if user or password:
        return (
            f"http://{quote(user, safe='')}:{quote(password, safe='')}@{host}:{port}"
        )
    return f"http://{host}:{port}"


def _env_truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _dedupe(urls: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for url in urls:
        if url and url not in seen:
            seen.add(url)
            out.append(url)
    return out


def resolve_scraper_proxies(
    *,
    proxy_list_path: str = "",
    proxy_url: str = "",
    proxy_urls: str = "",
    proxy_host: str = "",
    proxy_port: str = "",
    proxy_user: str = "",
    proxy_password: str = "",
    fallback_proxy_url: str = "",
    fallback_proxy_enabled: bool = False,
) -> list[str]:
    """Build the residential proxy pool from explicit settings / env."""
    found: list[str] = []

    path = (proxy_list_path or os.environ.get("SCRAPER_PROXY_LIST_PATH", "")).strip()
    if path:
        found.extend(_load_proxies_from_file(path))

    inline = (proxy_url or os.environ.get("SCRAPER_PROXY_URL", "")).strip()
    found.extend(_split_inline_urls(inline))

    multi = (proxy_urls or os.environ.get("SCRAPER_PROXY_URLS", "")).strip()
    found.extend(_split_inline_urls(multi))

    host = (proxy_host or os.environ.get("SCRAPER_PROXY_HOST", "")).strip()
    port = (proxy_port or os.environ.get("SCRAPER_PROXY_PORT", "")).strip()
    user = (proxy_user or os.environ.get("SCRAPER_PROXY_USER", "")
            or os.environ.get("SCRAPER_PROXY_USERNAME", "")).strip()
    password = (proxy_password or os.environ.get("SCRAPER_PROXY_PASSWORD", "")).strip()
    component = _from_components(host, port, user, password)
    if component:
        found.append(component)

    if not found:
        enabled = fallback_proxy_enabled
        if not enabled:
            enabled = _env_truthy(os.environ.get("PROXY_ENABLED"))
        fb = (fallback_proxy_url or os.environ.get("PROXY_URL", "") or "").strip()
        if enabled and fb:
            found.extend(_split_inline_urls(fb))
            if found:
                logger.info(
                    "Using PROXY_URL for scraper residential egress "
                    "(SCRAPER_PROXY_* not set)"
                )

    return _dedupe(found)


def resolve_scraper_proxies_from_settings() -> list[str]:
    """Resolve proxies using app settings + environment."""
    path = ""
    proxy_url = ""
    proxy_urls = ""
    host = port = user = password = ""
    fallback_url = ""
    fallback_enabled = False
    try:
        from app.core.config import get_settings

        s = get_settings()
        path = getattr(s, "scraper_proxy_list_path", "") or ""
        proxy_url = getattr(s, "scraper_proxy_url", "") or ""
        proxy_urls = getattr(s, "scraper_proxy_urls", "") or ""
        host = getattr(s, "scraper_proxy_host", "") or ""
        port = str(getattr(s, "scraper_proxy_port", "") or "")
        user = getattr(s, "scraper_proxy_user", "") or ""
        password = getattr(s, "scraper_proxy_password", "") or ""
        fallback_url = (getattr(s, "proxy_url", None) or "") or ""
        fallback_enabled = bool(getattr(s, "proxy_enabled", False))
    except Exception:
        pass

    return resolve_scraper_proxies(
        proxy_list_path=path,
        proxy_url=proxy_url,
        proxy_urls=proxy_urls,
        proxy_host=host,
        proxy_port=port,
        proxy_user=user,
        proxy_password=password,
        fallback_proxy_url=fallback_url,
        fallback_proxy_enabled=fallback_enabled,
    )


def proxy_egress_label(proxy_url: str | None) -> str:
    """Safe label for logs (host:port only)."""
    if not proxy_url:
        return "none"
    return proxy_url.split("@")[-1]
