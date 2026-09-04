"""Catalog of pluginable job sites.

Importing this module loads every plugin in ``app.job_sites.plugins``.
Adding a new site is: write a plugin module that calls ``register()``, then
import it from ``app.job_sites.plugins``.
"""

from __future__ import annotations

from app.job_sites.base import JobSitePlugin

_PLUGINS: dict[str, JobSitePlugin] = {}
_LOADED = False


def register(plugin: JobSitePlugin) -> JobSitePlugin:
    if plugin.slug in _PLUGINS:
        raise ValueError(f"Duplicate job-site plugin slug: {plugin.slug}")
    _PLUGINS[plugin.slug] = plugin
    return plugin


def _ensure_loaded() -> None:
    global _LOADED
    if _LOADED:
        return
    # Side-effect imports: each module calls register().
    from app.job_sites import plugins as _plugins  # noqa: F401

    _LOADED = True


def get_plugin(slug: str) -> JobSitePlugin | None:
    _ensure_loaded()
    return _PLUGINS.get((slug or "").strip().lower())


def list_plugins() -> list[JobSitePlugin]:
    _ensure_loaded()
    return sorted(_PLUGINS.values(), key=lambda p: (p.sort_order, p.name.lower()))
