"""Tool framework for the conversational agent.

A *tool* is a thin, strictly user-scoped wrapper over an existing capability
(search, stats, submit, sync, mark-applied, …). Each tool declares:

- a stable ``name`` the LLM references,
- a human description + parameter hints rendered into the planner prompt,
- whether it ``requires_confirmation`` (destructive / bulk / cost-incurring),
- which client data ``refresh`` targets to invalidate after a successful run,
- an async ``handler(ctx, args) -> ToolResult``.

Tools never receive a user identity from the model - ``ToolContext.user_id`` is
always injected server-side from the authenticated session, so the agent can
only ever act as the calling user.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

ToolHandler = Callable[["ToolContext", dict[str, Any]], Awaitable["ToolResult"]]


@dataclass(frozen=True)
class ToolContext:
    """Server-injected execution context. Never populated from model output."""

    user_id: str
    timezone: str | None = None


@dataclass
class ToolResult:
    ok: bool
    summary: str
    data: Any = None
    error: str | None = None
    # Client-side data caches to refresh after a successful mutation, e.g.
    # ["jobs", "stats", "sync"]. Read-only tools leave this empty.
    refresh: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ToolParam:
    name: str
    type: str
    description: str
    required: bool = False


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    params: list[ToolParam]
    handler: ToolHandler
    requires_confirmation: bool = False
    # Short imperative gerund shown in the UI while running, e.g. "Searching jobs".
    running_title: str = "Working"

    def prompt_signature(self) -> str:
        """One-line tool description for the planner catalog."""
        if self.params:
            parts = []
            for p in self.params:
                flag = "" if p.required else "?"
                parts.append(f"{p.name}{flag}: {p.type} - {p.description}")
            args = "; ".join(parts)
        else:
            args = "(no arguments)"
        confirm = " [REQUIRES CONFIRMATION]" if self.requires_confirmation else ""
        return f"- {self.name}{confirm}: {self.description}\n    args: {args}"


_REGISTRY: dict[str, ToolSpec] = {}


def register_tool(spec: ToolSpec) -> ToolSpec:
    _REGISTRY[spec.name] = spec
    return spec


def get_tool(name: str) -> ToolSpec | None:
    return _REGISTRY.get(name)


def registered_tools() -> list[ToolSpec]:
    return list(_REGISTRY.values())


def catalog_prompt() -> str:
    """Render every registered tool into a compact catalog for the system prompt."""
    return "\n".join(spec.prompt_signature() for spec in _REGISTRY.values())
