"""Merge structured job dicts from JSON-LD, static HTML, and browser without slowing the fast path."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

# Below this length we try richer sources (browser, iframe) before giving up on "full" JD text.
RICH_DESCRIPTION_MIN_CHARS: int = 900

def description_len(structured: dict | None) -> int:
    if not structured:
        return 0
    return len((structured.get("description") or "").strip())


def is_rich_description(structured: dict | None) -> bool:
    return description_len(structured) >= RICH_DESCRIPTION_MIN_CHARS


def skip_early_static_html_exit(url: str) -> bool:
    """
    Known ATS / embed hosts where a long first-pass HTML description is often marketing shell,
    not the real JD. Defer early finalize so vendor API or browser can run — no extra cost for
    normal employer sites (returns False).
    """
    if not url:
        return False
    u = url.strip()
    low = u.lower()
    try:
        host = urlparse(u).netloc.lower()
    except Exception:
        host = ""
    if "apply.workable.com" in host:
        return True
    if "ashby_jid=" in low:
        return True
    if "gh_jid=" in low:
        return True
    return False


def _merge_str_lists(a: list[Any] | None, b: list[Any] | None) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for x in (a or []) + (b or []):
        if x is None:
            continue
        s = str(x).strip()
        if not s:
            continue
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out


def merge_structured_job_data(base: dict | None, overlay: dict | None) -> dict | None:
    """
    Prefer the longer description; fill empty scalar fields from overlay; merge list fields.
    """
    if not overlay and not base:
        return None
    if not base:
        return dict(overlay) if overlay else None
    if not overlay:
        return dict(base)
    merged: dict[str, Any] = dict(base)
    for k, v in overlay.items():
        if k == "description":
            bd = (merged.get("description") or "").strip()
            od = (overlay.get("description") or "").strip()
            if len(od) > len(bd):
                merged["description"] = overlay.get("description")
        elif k in ("responsibilities", "requirements", "benefits"):
            merged[k] = _merge_str_lists(merged.get(k), overlay.get(k))
        elif k == "raw_metadata":
            md: dict[str, Any] = dict(merged.get("raw_metadata") or {})
            md.update(overlay.get("raw_metadata") or {})
            merged["raw_metadata"] = md
        else:
            if v is None:
                continue
            if isinstance(v, str) and not v.strip():
                continue
            cur = merged.get(k)
            if cur is None or (isinstance(cur, str) and not str(cur).strip()):
                merged[k] = v
    return merged
