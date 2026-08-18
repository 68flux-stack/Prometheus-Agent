"""Prometheus todo skill: display a progress checklist in the UI."""

from __future__ import annotations

from typing import Any
from rlm import host_request


async def set(title: str, items: list[str]) -> dict[str, Any]:
    """Set the active todo list."""
    return await host_request("todo.set", {"title": str(title), "items": list(items)})


async def update(index: int, status: str) -> dict[str, Any]:
    """Update task status ('in_progress', 'done', 'pending')."""
    return await host_request("todo.update", {"id": str(index), "status": str(status)})


async def clear() -> dict[str, Any]:
    """Clear the todo list."""
    return await host_request("todo.clear")
