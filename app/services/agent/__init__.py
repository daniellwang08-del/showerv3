"""Conversational AI agent that can perform user actions across the platform.

The agent exposes a registry of *tools* (thin wrappers over existing API route
handlers / services) and an orchestrator that lets an LLM plan and call those
tools in a loop to satisfy a natural-language request.

Public surface:
    from app.services.agent import AGENT_TOOLS, run_agent_turn, ToolContext
"""

from app.services.agent.base import (
    ToolContext,
    ToolResult,
    ToolSpec,
    get_tool,
    registered_tools,
)
from app.services.agent.catalog import AGENT_TOOLS
from app.services.agent.orchestrator import run_agent_turn

__all__ = [
    "AGENT_TOOLS",
    "ToolContext",
    "ToolResult",
    "ToolSpec",
    "get_tool",
    "registered_tools",
    "run_agent_turn",
]
