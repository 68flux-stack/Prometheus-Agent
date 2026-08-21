"""Self-check for the websearch error formatting: run `python test_websearch.py`."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "src"))

from websearch.websearch import _describe_error  # noqa: E402

RATE_LIMIT = "You've hit Exa's free MCP rate limit. Create your own Exa API key."


def test_plain_error():
    assert _describe_error(RuntimeError("boom")) == "boom"


def test_empty_message_falls_back_to_type():
    assert _describe_error(RuntimeError()) == "RuntimeError"


def test_nested_exception_groups_are_flattened():
    inner = ExceptionGroup("unhandled errors in a TaskGroup", [RuntimeError(RATE_LIMIT)])
    outer = ExceptionGroup("unhandled errors in a TaskGroup", [inner])
    message = _describe_error(outer)
    assert RATE_LIMIT in message
    assert "TaskGroup" not in message


def test_rate_limit_adds_login_hint(monkeypatch=None):
    import websearch.websearch as ws

    original = ws._resolve_api_key
    ws._resolve_api_key = lambda: ""
    try:
        message = _describe_error(RuntimeError(RATE_LIMIT))
    finally:
        ws._resolve_api_key = original
    assert "/login" in message


if __name__ == "__main__":
    test_plain_error()
    test_empty_message_falls_back_to_type()
    test_nested_exception_groups_are_flattened()
    test_rate_limit_adds_login_hint()
    print("ok")
