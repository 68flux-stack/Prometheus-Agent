---
name: websearch
description: Search the web via Exa's MCP server. Works anonymously out of the box; for a higher rate limit, configure a key via /login, then MCP Connections, then Exa (web search). Takes one query and returns titles, URLs, and content highlights.
---

# Web Search

Search the web via Exa's remote MCP server (`https://mcp.exa.ai/mcp`).

## Setup

None required — this works out of the box against Exa's free anonymous tier.

If you're hitting rate limits, get a free API key at https://exa.ai, then run
`/login` in Prometheus, switch to **MCP Connections**, and choose **Exa (web
search)** to paste it. The key is stored in Prometheus and made available to
this skill automatically.

Optional overrides (environment variables):

- `PROMETHEUS_WEBSEARCH_TIMEOUT` - request timeout in seconds (default 45).
- `PROMETHEUS_WEBSEARCH_NUM_RESULTS` - number of results to return (default 5).

## Usage

Call the prepared `websearch` import directly in the IPython kernel:

```python
print(await websearch("latest Prometheus release"))
```
