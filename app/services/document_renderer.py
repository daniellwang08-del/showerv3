"""Server-side PDF rendering for resumes and cover letters.

The PDF is produced by printing the studio's own page frames in headless Chromium:
the print bundle (``frontend/src/print``, built into ``app/assets/print``) contains
the same React templates, fonts and paginator the user sees while designing. So a
PDF page is the on-screen page, not a re-implementation of it.

Isolation: every render gets a fresh browser context whose only reachable origin is
the bundle on local disk. All other requests are aborted, service workers are
blocked, and the payload is plain JSON data (never HTML).
"""

from __future__ import annotations

import asyncio
import json
import mimetypes
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from app.core.logging import get_logger

logger = get_logger(__name__)

PRINT_DIR = Path(__file__).resolve().parents[1] / "assets" / "print"
_ORIGIN = "http://nao-print.invalid"
_RENDER_TIMEOUT_S = 45
_MAX_CONCURRENT = 3

_LAUNCH_ARGS = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    # Unhinted glyph advances, the same metrics the studio lays out with.
    "--font-render-hinting=none",
]

_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".ttf": "font/ttf",
    ".woff2": "font/woff2",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}


class RendererUnavailable(RuntimeError):
    """The print bundle or Chromium is missing; callers may fall back."""


@dataclass
class RenderResult:
    pdf: bytes
    page_count: int
    breaks: list[float] = field(default_factory=list)
    paper: str = "letter"
    fonts_loaded: bool = True


class DocumentRenderer:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._sem = asyncio.Semaphore(_MAX_CONCURRENT)
        self._playwright = None
        self._browser = None

    def bundle_ready(self) -> bool:
        return (PRINT_DIR / "print.html").is_file()

    async def _ensure_browser(self):
        if self._browser is not None and self._browser.is_connected():
            return self._browser
        async with self._lock:
            if self._browser is not None and self._browser.is_connected():
                return self._browser
            from playwright.async_api import async_playwright

            if self._playwright is None:
                self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(headless=True, args=_LAUNCH_ARGS)
            logger.info("document_renderer_browser_started")
            return self._browser

    async def close(self) -> None:
        async with self._lock:
            if self._browser is not None:
                try:
                    await self._browser.close()
                except Exception:  # noqa: BLE001
                    pass
                self._browser = None
            if self._playwright is not None:
                try:
                    await self._playwright.stop()
                except Exception:  # noqa: BLE001
                    pass
                self._playwright = None

    @staticmethod
    async def _serve(route) -> None:
        url = route.request.url
        if url.startswith("data:") or url.startswith("blob:"):
            await route.continue_()
            return
        parsed = urlparse(url)
        if f"{parsed.scheme}://{parsed.netloc}" != _ORIGIN:
            await route.abort("blockedbyclient")
            return
        rel = parsed.path.lstrip("/") or "print.html"
        target = (PRINT_DIR / rel).resolve()
        if PRINT_DIR.resolve() not in target.parents or not target.is_file():
            await route.fulfill(status=404, body="not found")
            return
        ctype = _CONTENT_TYPES.get(target.suffix.lower()) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        await route.fulfill(status=200, body=target.read_bytes(), headers={"content-type": ctype})

    async def render_pdf(self, payload: dict[str, Any], *, title: str | None = None) -> RenderResult:
        if not self.bundle_ready():
            raise RendererUnavailable(
                f"Print bundle missing at {PRINT_DIR}. Run `npm run build:print` in frontend/."
            )
        async with self._sem:
            browser = await self._ensure_browser()
            context = await browser.new_context(
                java_script_enabled=True,
                service_workers="block",
                viewport={"width": 1000, "height": 1300},
                device_scale_factor=1,
                accept_downloads=False,
            )
            try:
                await context.route("**/*", self._serve)
                page = await context.new_page()
                await page.goto(f"{_ORIGIN}/print.html", wait_until="load", timeout=_RENDER_TIMEOUT_S * 1000)
                await page.wait_for_function("typeof window.renderResume === 'function'", timeout=10_000)
                info = await asyncio.wait_for(
                    page.evaluate("(p) => window.renderResume(p)", payload),
                    timeout=_RENDER_TIMEOUT_S,
                )
                if title:
                    await page.evaluate("(t) => { document.title = t }", title)
                pdf = await page.pdf(
                    print_background=True,
                    prefer_css_page_size=True,
                    margin={"top": "0", "right": "0", "bottom": "0", "left": "0"},
                    tagged=True,
                )
            finally:
                await context.close()
        result = RenderResult(
            pdf=pdf,
            page_count=int(info.get("pageCount") or 0),
            breaks=[float(b) for b in info.get("breaks") or []],
            paper=str(info.get("paper") or "letter"),
            fonts_loaded=bool(info.get("fontsLoaded", True)),
        )
        if not result.fonts_loaded:
            logger.warning("document_render_font_fallback", font=payload.get("design", {}).get("typography", {}).get("font_family"))
        return result


_renderer: DocumentRenderer | None = None


def get_document_renderer() -> DocumentRenderer:
    global _renderer
    if _renderer is None:
        _renderer = DocumentRenderer()
    return _renderer


async def close_document_renderer() -> None:
    if _renderer is not None:
        await _renderer.close()


# ── Payload helpers ────────────────────────────────────────────────────────────


def profile_payload(user: Any) -> dict[str, Any]:
    """The user's profile in the exact JSON shape the web app receives.

    Call while the user's DB session is open (it reads loaded attributes)."""
    from app.api.routes import _user_to_profile_response

    return json.loads(_user_to_profile_response(user).model_dump_json())


def cover_letter_paragraphs(body: str) -> list[str]:
    return [p.strip("\r ") for p in (body or "").split("\n\n") if p.strip()]


async def render_resume_pdf(design: Any, profile: dict[str, Any], *, title: str | None = None) -> RenderResult:
    payload = {"design": design.model_dump(mode="json"), "profile": profile, "letter": None}
    return await get_document_renderer().render_pdf(payload, title=title)


async def render_cover_letter_pdf(
    design: Any, profile: dict[str, Any], body: str, *, title: str | None = None
) -> RenderResult:
    paragraphs = cover_letter_paragraphs(body)
    if not paragraphs:
        raise ValueError("Cover letter body is empty.")
    payload = {
        "design": design.model_dump(mode="json"),
        "profile": profile,
        "letter": {"title": "Cover Letter", "paragraphs": paragraphs},
    }
    return await get_document_renderer().render_pdf(payload, title=title)
