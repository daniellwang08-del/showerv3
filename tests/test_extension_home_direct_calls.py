"""``/extension/home`` calls route functions as plain coroutines.

FastAPI only resolves ``Query(...)`` defaults for real requests, so any
parameter the direct call leaves out arrives as a ``Query`` object (and once
reached Postgres as ``invalid input for query argument``). Every parameter of
the called routes must be passed explicitly.
"""

from __future__ import annotations

import ast
import inspect
from pathlib import Path

from app.api import routes

EXTENSION_ROUTES = Path(__file__).resolve().parents[1] / "app" / "api" / "extension_routes.py"
DIRECT_ROUTE_CALLS = {
    "get_dashboard_counts": routes.get_dashboard_counts,
    "get_weekly_progress": routes.get_weekly_progress,
}


def _calls_in_extension_routes() -> dict[str, list[set[str]]]:
    tree = ast.parse(EXTENSION_ROUTES.read_text(encoding="utf-8"))
    found: dict[str, list[set[str]]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in DIRECT_ROUTE_CALLS:
            assert not node.args, f"{node.func.id} must be called with keyword arguments only"
            found.setdefault(node.func.id, []).append({kw.arg for kw in node.keywords if kw.arg})
    return found


def test_extension_home_passes_every_route_parameter():
    calls = _calls_in_extension_routes()
    assert set(calls) == set(DIRECT_ROUTE_CALLS)
    for name, fn in DIRECT_ROUTE_CALLS.items():
        params = set(inspect.signature(fn).parameters)
        for passed in calls[name]:
            missing = params - passed
            assert not missing, f"{name} is called without {sorted(missing)}; FastAPI will not fill them"
