"""Websearch skill implementation: search via Exa's remote MCP server."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from rlm import McpIntegration

EXA_MCP_URL = "https://mcp.exa.ai/mcp"
MAX_FETCH_URLS = 10
MAX_FETCH_CHARS = 50_000


def _env_int(name: str, default: int) -> int:
    """Read an int from the environment, falling back to default on bad values."""
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


def _agent_dir() -> Path:
    """Resolve the Prometheus config dir the same way the runtime does."""
    raw = (
        os.environ.get("PROMETHEUS_CODING_AGENT_DIR")
        or os.environ.get("PI_CODING_AGENT_DIR")
        or str(Path.home() / ".prime" / "agent")
    )
    return Path(raw).expanduser()


def _resolve_config_value(value: str) -> str:
    # Stored keys may be a literal or an env-var name; "!command" refs can't be run
    # safely here, so skip them (the agent injects those resolved at build time).
    value = value.strip()
    if not value or value.startswith("!"):
        return ""
    return (os.environ.get(value) or value).strip()


def _resolve_api_key() -> str:
    # Optional: Exa's MCP server works anonymously (rate-limited). A key only
    # raises that limit. Read auth.json on each call (not just the injected env
    # var) so a key added via /login after the kernel started is still picked up.
    env_key = os.environ.get("EXA_API_KEY", "").strip()
    if env_key:
        return env_key

    try:
        auth = json.loads((_agent_dir() / "auth.json").read_text())
        cred = auth.get("exa") if isinstance(auth, dict) else None
        if isinstance(cred, dict) and cred.get("type") == "api_key":
            return _resolve_config_value(str(cred.get("key") or ""))
    except (OSError, ValueError):
        pass
    return ""


class _Exa(McpIntegration):
    server = "exa"
    url = EXA_MCP_URL

    def __init__(self) -> None:
        super().__init__()
        # The TCP+TLS handshake dominates per-call latency (the MCP session
        # itself, one per call, is cheap once connected). Keep one pooled
        # httpx client alive across calls so repeat searches reuse the open
        # connection. A ClientSession isn't reused the same way: ipykernel may
        # run each cell as its own asyncio task, and anyio's task groups
        # (which the MCP session's stream machinery relies on) aren't safe to
        # use across tasks — a plain httpx connection pool is.
        self._http_client = None
        self._http_client_key: tuple[tuple[str, str], ...] | None = None

    async def _get_http_client(self, headers: dict[str, str]):
        import httpx

        key = tuple(sorted(headers.items()))
        if self._http_client is not None and self._http_client_key == key:
            return self._http_client
        if self._http_client is not None:
            await self._http_client.aclose()
        self._http_client = httpx.AsyncClient(headers=headers)
        self._http_client_key = key
        return self._http_client

    async def _open_session(self, stack):
        from mcp import ClientSession

        url, extra_headers = await self._resolve_config()
        api_key = _resolve_api_key()
        headers = {**extra_headers, "x-api-key": api_key} if api_key else dict(extra_headers)

        try:
            from mcp.client.streamable_http import streamable_http_client

            client = await self._get_http_client(headers)
            cm = streamable_http_client(url, http_client=client)
        except ImportError:
            # Older `mcp` SDKs only expose the deprecated wrapper, which always
            # owns (and closes) its own client — correct, just unpooled.
            import inspect

            from rlm.mcp_base import _resolve_streamable_http

            transport = _resolve_streamable_http()
            params = inspect.signature(transport).parameters
            if "headers" in params:
                cm = transport(url, headers=headers or None)
            elif "http_client" in params:
                import httpx

                client = await stack.enter_async_context(httpx.AsyncClient(headers=headers))
                cm = transport(url, http_client=client)
            else:
                raise RuntimeError(f"unsupported mcp streamable-HTTP client signature: {tuple(params)}")

        read, write, *_ = await stack.enter_async_context(cm)
        session = await stack.enter_async_context(ClientSession(read, write))
        await session.initialize()
        return session


_exa = _Exa()


async def _fetch_exa(query: str, timeout: int, num_results: int) -> str:
    """Search via Exa's MCP server (the ``web_search_exa`` tool)."""
    if os.environ.get("PROMETHEUS_WINDOWS_PLAN_MODE") == "1":
        from rlm import host_request

        payload = await host_request(
            "websearch.search",
            {"query": query, "timeout": timeout, "num_results": num_results},
        )
        text = payload.get("text")
        if not isinstance(text, str):
            raise RuntimeError("Prometheus returned an invalid web search response")
        return text or f"No results returned for query: {query}"

    result = await asyncio.wait_for(
        _exa.call_tool("web_search_exa", {"query": query, "numResults": num_results}),
        timeout=timeout,
    )
    if not isinstance(result, str):
        result = json.dumps(result)
    return result or f"No results returned for query: {query}"


async def _fetch_pages_exa(urls: list[str], timeout: int, max_chars: int) -> str:
    """Read full page content via Exa's MCP server (the ``web_fetch_exa`` tool)."""
    if os.environ.get("PROMETHEUS_WINDOWS_PLAN_MODE") == "1":
        from rlm import host_request

        payload = await host_request(
            "websearch.fetch",
            {"urls": urls, "timeout": timeout, "max_chars": max_chars},
        )
        text = payload.get("text")
        if not isinstance(text, str):
            raise RuntimeError("Prometheus returned an invalid web fetch response")
        return text or f"No content returned for: {', '.join(urls)}"

    result = await asyncio.wait_for(
        _exa.call_tool("web_fetch_exa", {"urls": urls, "maxCharacters": max_chars}),
        timeout=timeout,
    )
    if not isinstance(result, str):
        result = json.dumps(result)
    return result or f"No content returned for: {', '.join(urls)}"


async def fetch(
    urls: str | list[str],
    *,
    max_chars: int = 8000,
    timeout: int | None = None,
) -> str:
    """Read one or more web pages in full, as clean markdown.

    Args:
        urls: A single URL or a list of URLs (batched into one request).
        max_chars: Maximum characters extracted per page.
        timeout: Request timeout in seconds.

    Returns:
        Page content, or an error string on failure.
    """
    url_list = [urls] if isinstance(urls, str) else list(urls)
    if not url_list:
        raise ValueError("fetch requires at least one URL")
    if len(url_list) > MAX_FETCH_URLS:
        raise ValueError(f"fetch accepts at most {MAX_FETCH_URLS} URLs per call")
    if max_chars < 1 or max_chars > MAX_FETCH_CHARS:
        raise ValueError(f"max_chars must be between 1 and {MAX_FETCH_CHARS}")

    if timeout is None:
        timeout = _env_int("PROMETHEUS_WEBSEARCH_TIMEOUT", 45)

    try:
        return await _fetch_pages_exa(url_list, timeout=timeout, max_chars=max_chars)
    except Exception as e:
        return f"Error fetching {', '.join(url_list)}: {e}"


async def run(
    query: str,
    *,
    max_output: int = 8192,
    timeout: int | None = None,
    num_results: int | None = None,
) -> str:
    """Run a web search via Exa's MCP server and return formatted results.

    Args:
        query: Natural-language search query.
        max_output: Truncate output to this many chars.
        timeout: Request timeout in seconds.
        num_results: Number of results to return.

    Returns:
        Formatted search results.
    """
    if timeout is None:
        timeout = _env_int("PROMETHEUS_WEBSEARCH_TIMEOUT", 45)
    if num_results is None:
        num_results = _env_int("PROMETHEUS_WEBSEARCH_NUM_RESULTS", 5)

    try:
        result = await _fetch_exa(query, timeout=timeout, num_results=num_results)
    except Exception as e:
        result = f"Error searching for '{query}': {e}"
    output = f'Results for query "{query}":\n\n{result}'

    if len(output) > max_output:
        total = len(output)
        marker = f"\n... [output truncated, {total} chars total] ...\n"
        # Reserve room for the marker so the result stays within max_output.
        half = max(0, (max_output - len(marker)) // 2)
        output = output[:half] + marker + output[len(output) - half:]
        if len(output) > max_output:  # marker alone exceeds the budget
            output = output[:max_output]

    return output
