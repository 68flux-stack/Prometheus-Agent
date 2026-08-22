# Prometheus runtime

The IPython kernel exposes `rlm` for recursive agents and `lsp` for opt-in
language-server operations. Call LSP methods from a cell, for example:

```python
await lsp.diagnostics("src/example.py")
await lsp.hover("src/example.py", 12, 4)
await lsp.rename("src/example.py", 12, 4, "new_name")
```

`hover`, `definition`, `references`, `workspace_symbols`, and `code_actions`
return the server response. `rename` and `apply_code_action` apply returned
workspace edits and then refresh diagnostics for each affected file.

Configure a server in either `~/.prometheus/agent/lsp.json` or
`<workspace>/.prime/lsp.json`; project entries override user entries. The
compact form is a language-keyed object:

```json
{
  "python": {
    "command": "pyright-langserver",
    "args": ["--stdio"],
    "extensions": [".py", ".pyi"]
  }
}
```

TypeScript/JavaScript (`typescript-language-server --stdio`) and Python
(`pyright-langserver --stdio`) are detected when installed. Prometheus never
installs a language server; missing servers return a clear runtime error.

Run explicit background commands through the same session-owned runtime:

```python
job = await rlm.jobs.start("npm run check")
update = await job.wait()
print(update.job.status, await job.tail())
```

Use `rlm.jobs.list()`, `get()`, `tail()`, `wait()`, `write()`, and `cancel()` to manage jobs without polling loops.
