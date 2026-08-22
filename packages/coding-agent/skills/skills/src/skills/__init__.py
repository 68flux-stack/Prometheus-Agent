"""Prometheus skills meta-skill: on-demand skill discovery from the kernel.

Most installed skills are withheld from the base system prompt to save
context (see `INLINE_DOCUMENTED_SKILL_NAMES` and the `eager` skill field on
the host side). These functions are thin typed wrappers over the generic host
bridge (`rlm.host_request`) that let the model list and read them on demand
instead. They only work inside the Prometheus IPython kernel.
"""

from __future__ import annotations

from typing import Any

from rlm import host_request


async def list(query: str | None = None) -> list[dict[str, Any]]:  # noqa: A001 - matches skills.list() call site
    """List installed skills not already described elsewhere in context.

    Does not include primitives already documented in the base prompt
    (websearch, compact, goal, todo, edit, attach_image, agent_observe,
    agent_message, rlm_heartbeat, etc.) — those need no lookup, call them
    directly. Each entry has `name`, `kind` (`"markdown"` or `"python"`),
    `description`, and `python_import` when the skill is python-backed and
    already pre-imported. Optional `query` does a case-insensitive substring
    match over name and description.
    """
    payload: dict[str, Any] = {}
    if query is not None:
        if not isinstance(query, str):
            raise TypeError(f"query must be str or None, got {type(query).__name__}")
        payload["query"] = query
    result = await host_request("skills.list", payload)
    return result["skills"]


async def read(name: str) -> str:
    """Read the full SKILL.md body for one installed skill by name.

    Raises if `name` does not match an installed, non-hidden skill; the error
    includes a suggestion when a close name match exists.
    """
    if not isinstance(name, str) or not name:
        raise TypeError("name must be a non-empty str")
    result = await host_request("skills.read", {"name": name})
    return result["content"]
