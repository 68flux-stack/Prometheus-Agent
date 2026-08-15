"""Small, opt-in Language Server Protocol client for the IPython runtime.

Configuration is loaded from ``~/.prometheus/agent/lsp.json`` and
``.prime/lsp.json`` in the current workspace.  A project entry overrides a user
entry with the same language key.  Servers are never installed by this module.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote


DEFAULT_SERVERS: dict[str, dict[str, Any]] = {
    "typescript": {"command": "typescript-language-server", "args": ["--stdio"], "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]},
    "python": {"command": "pyright-langserver", "args": ["--stdio"], "extensions": [".py", ".pyi"]},
}
IDLE_TIMEOUT_SECONDS = 10 * 60


class LspUnavailableError(RuntimeError):
    """Raised when no usable configured language server is available."""


def _uri(path: Path) -> str:
    return "file://" + quote(str(path.resolve()).replace("\\", "/"), safe="/:@")


def _position(line: int, character: int) -> dict[str, int]:
    if line < 0 or character < 0:
        raise ValueError("line and character must be non-negative")
    return {"line": line, "character": character}


def _load_config(path: Path) -> dict[str, dict[str, Any]]:
    if not path.is_file():
        return {}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise LspUnavailableError(f"Invalid LSP configuration at {path}: {exc}") from exc
    servers = parsed.get("servers", parsed)
    if not isinstance(servers, dict):
        raise LspUnavailableError(f"LSP configuration at {path} must contain a servers object")
    return {key: value for key, value in servers.items() if isinstance(key, str) and isinstance(value, dict)}


def _server_config(workspace: Path, language: str) -> dict[str, Any] | None:
    user = _load_config(Path.home() / ".prime" / "agent" / "lsp.json")
    project = _load_config(workspace / ".prime" / "lsp.json")
    configured = {**user, **project}
    value = configured.get(language)
    if value is not None:
        return value
    return DEFAULT_SERVERS.get(language)


def _language_for(path: Path, workspace: Path) -> str:
    configured = {**_load_config(Path.home() / ".prime" / "agent" / "lsp.json"), **_load_config(workspace / ".prime" / "lsp.json")}
    for name, value in {**DEFAULT_SERVERS, **configured}.items():
        extensions = value.get("extensions", [])
        if isinstance(extensions, list) and path.suffix.lower() in extensions:
            return name
    raise LspUnavailableError(f"No LSP server is configured for {path.suffix or 'files without an extension'}")


@dataclass
class _Client:
    workspace: Path
    language: str
    config: dict[str, Any]
    process: asyncio.subprocess.Process | None = None
    pending: dict[int, asyncio.Future[Any]] = field(default_factory=dict)
    diagnostics: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    documents: dict[str, int] = field(default_factory=dict)
    reader: asyncio.Task[None] | None = None
    next_id: int = 1
    last_activity: float = field(default_factory=time.monotonic)

    async def start(self) -> None:
        command = self.config.get("command")
        args = self.config.get("args", [])
        if not isinstance(command, str) or not command:
            raise LspUnavailableError(f"LSP server {self.language!r} has no command")
        if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
            raise LspUnavailableError(f"LSP server {self.language!r} has invalid args")
        executable = self._resolve_command(command)
        if executable is None:
            raise LspUnavailableError(
                f"LSP server for {self.language} is unavailable: {command!r} was not found. "
                "Install it yourself or configure its command in .prime/lsp.json."
            )
        self.process = await asyncio.create_subprocess_exec(
            executable, *args, cwd=self.workspace, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        self.reader = asyncio.create_task(self._read_loop())
        await self.request(
            "initialize",
            {
                "processId": os.getpid(),
                "rootUri": _uri(self.workspace),
                "workspaceFolders": [{"uri": _uri(self.workspace), "name": self.workspace.name}],
                "capabilities": {
                    "workspace": {
                        "workspaceEdit": {"documentChanges": False},
                        "symbol": {"dynamicRegistration": False},
                    },
                    "textDocument": {
                        "codeAction": {
                            "codeActionLiteralSupport": {"codeActionKind": {"valueSet": [""]}}
                        }
                    },
                },
            },
        )
        await self.notify("initialized", {})

    def _resolve_command(self, command: str) -> str | None:
        candidate = Path(command)
        if candidate.is_absolute() and candidate.is_file():
            return str(candidate)
        local = self.workspace / "node_modules" / ".bin" / command
        if os.name == "nt":
            local = local.with_suffix(".cmd")
        if local.is_file():
            return str(local)
        return shutil.which(command)

    async def _read_loop(self) -> None:
        assert self.process and self.process.stdout
        try:
            while True:
                headers: dict[str, str] = {}
                while True:
                    line = await self.process.stdout.readline()
                    if not line:
                        return
                    if line in (b"\n", b"\r\n"):
                        break
                    key, _, value = line.decode("ascii", "replace").partition(":")
                    headers[key.lower()] = value.strip()
                length = int(headers.get("content-length", "0"))
                message = json.loads((await self.process.stdout.readexactly(length)).decode("utf-8"))
                if "id" in message and (future := self.pending.pop(message["id"], None)) is not None:
                    if "error" in message:
                        future.set_exception(RuntimeError(f"LSP {self.language} error: {message['error']}"))
                    else:
                        future.set_result(message.get("result"))
                elif message.get("method") == "textDocument/publishDiagnostics":
                    params = message.get("params", {})
                    if isinstance(params, dict) and isinstance(params.get("uri"), str):
                        self.diagnostics[params["uri"]] = params.get("diagnostics", [])
        except (asyncio.IncompleteReadError, json.JSONDecodeError, ValueError) as exc:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(LspUnavailableError(f"LSP server {self.language} stopped unexpectedly: {exc}"))
            self.pending.clear()

    async def _send(self, message: dict[str, Any]) -> None:
        if not self.process or not self.process.stdin or self.process.returncode is not None:
            raise LspUnavailableError(f"LSP server {self.language} is not running")
        encoded = json.dumps(message, separators=(",", ":")).encode("utf-8")
        self.process.stdin.write(f"Content-Length: {len(encoded)}\r\n\r\n".encode("ascii") + encoded)
        await self.process.stdin.drain()
        self.last_activity = time.monotonic()

    async def request(self, method: str, params: dict[str, Any]) -> Any:
        request_id = self.next_id
        self.next_id += 1
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        await self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        return await asyncio.wait_for(future, timeout=30)

    async def notify(self, method: str, params: dict[str, Any]) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": params})

    async def open(self, path: Path) -> str:
        uri = _uri(path)
        text = path.read_text(encoding="utf-8")
        version = self.documents.get(uri, 0) + 1
        if uri not in self.documents:
            await self.notify("textDocument/didOpen", {"textDocument": {"uri": uri, "languageId": self.language, "version": version, "text": text}})
        else:
            await self.notify("textDocument/didChange", {"textDocument": {"uri": uri, "version": version}, "contentChanges": [{"text": text}]})
        self.documents[uri] = version
        return uri

    async def close(self) -> None:
        if not self.process:
            return
        try:
            await self.request("shutdown", {})
            await self.notify("exit", {})
        except (RuntimeError, LspUnavailableError):
            pass
        self.process.terminate()
        await self.process.wait()


_clients: dict[tuple[Path, str], _Client] = {}


async def _client(path: str | Path) -> tuple[_Client, Path, str]:
    file = Path(path).resolve()
    if not file.is_file():
        raise FileNotFoundError(file)
    workspace = Path.cwd().resolve()
    language = _language_for(file, workspace)
    key = (workspace, language)
    client = _clients.get(key)
    if client is None or client.process is None or client.process.returncode is not None:
        config = _server_config(workspace, language)
        if config is None:
            raise LspUnavailableError(f"No LSP server is configured for {language}")
        client = _Client(workspace, language, config)
        _clients[key] = client
        await client.start()
    uri = await client.open(file)
    return client, file, uri


async def diagnostics(path: str | Path) -> list[dict[str, Any]]:
    client, _, uri = await _client(path)
    await asyncio.sleep(0.05)
    return client.diagnostics.get(uri, [])


async def hover(path: str | Path, line: int, character: int) -> Any:
    client, _, uri = await _client(path)
    return await client.request("textDocument/hover", {"textDocument": {"uri": uri}, "position": _position(line, character)})


async def definition(path: str | Path, line: int, character: int) -> Any:
    client, _, uri = await _client(path)
    return await client.request("textDocument/definition", {"textDocument": {"uri": uri}, "position": _position(line, character)})


async def references(path: str | Path, line: int, character: int, include_declaration: bool = True) -> Any:
    client, _, uri = await _client(path)
    return await client.request("textDocument/references", {"textDocument": {"uri": uri}, "position": _position(line, character), "context": {"includeDeclaration": include_declaration}})


async def workspace_symbols(query: str = "") -> Any:
    workspace = Path.cwd().resolve()
    config = _server_config(workspace, "typescript") or _server_config(workspace, "python")
    if config is None:
        raise LspUnavailableError("No configured LSP server supports workspace symbols")
    language = "typescript" if _server_config(workspace, "typescript") else "python"
    client = _clients.get((workspace, language))
    if client is None:
        client = _Client(workspace, language, config)
        _clients[(workspace, language)] = client
        await client.start()
    return await client.request("workspace/symbol", {"query": query})


async def code_actions(path: str | Path, start_line: int, start_character: int, end_line: int, end_character: int, diagnostics_: list[dict[str, Any]] | None = None) -> Any:
    client, _, uri = await _client(path)
    return await client.request("textDocument/codeAction", {"textDocument": {"uri": uri}, "range": {"start": _position(start_line, start_character), "end": _position(end_line, end_character)}, "context": {"diagnostics": diagnostics_ or client.diagnostics.get(uri, [])}})


def _edits_for_document(text: str, edits: list[dict[str, Any]]) -> str:
    lines = text.splitlines(keepends=True)
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line))
    def offset(position: dict[str, int]) -> int:
        line = position["line"]
        if line >= len(offsets):
            raise ValueError("workspace edit position is outside the document")
        return offsets[line] + position["character"]
    ordered = sorted(edits, key=lambda edit: offset(edit["range"]["start"]), reverse=True)
    for edit in ordered:
        start, end = offset(edit["range"]["start"]), offset(edit["range"]["end"])
        text = text[:start] + edit.get("newText", "") + text[end:]
    return text


def apply_workspace_edit(edit: dict[str, Any]) -> list[str]:
    """Apply a LSP WorkspaceEdit atomically per workspace transaction.

    All replacement text is prepared before a temporary-file swap begins.  If a
    swap fails, original bytes are restored for every file already changed.
    """
    changes = edit.get("changes", {})
    if not isinstance(changes, dict):
        raise ValueError("Only WorkspaceEdit.changes is supported by this minimal client")
    prepared: list[tuple[Path, bytes, bytes]] = []
    for uri, edits in changes.items():
        if not isinstance(uri, str) or not uri.startswith("file://") or not isinstance(edits, list):
            raise ValueError("WorkspaceEdit contains an invalid file change")
        path = Path(unquote(uri[7:]))
        old = path.read_bytes()
        new = _edits_for_document(old.decode("utf-8"), edits).encode("utf-8")
        prepared.append((path, old, new))
    token = uuid.uuid4().hex
    changed: list[tuple[Path, bytes]] = []
    try:
        for path, old, new in prepared:
            temp = path.with_name(f".{path.name}.{token}.tmp")
            temp.write_bytes(new)
            os.replace(temp, path)
            changed.append((path, old))
    except Exception:
        for path, old in reversed(changed):
            temp = path.with_name(f".{path.name}.{token}.restore")
            temp.write_bytes(old)
            os.replace(temp, path)
        raise
    return [str(path) for path, _, _ in prepared]


async def rename(path: str | Path, line: int, character: int, new_name: str) -> list[str]:
    client, _, uri = await _client(path)
    edit = await client.request("textDocument/rename", {"textDocument": {"uri": uri}, "position": _position(line, character), "newName": new_name})
    if not isinstance(edit, dict):
        raise RuntimeError("LSP server returned no workspace edit for rename")
    changed = apply_workspace_edit(edit)
    for changed_path in changed:
        await _client(changed_path)
        await diagnostics(changed_path)
    return changed


async def apply_code_action(action: dict[str, Any]) -> list[str]:
    edit = action.get("edit") if isinstance(action, dict) else None
    if not isinstance(edit, dict):
        raise ValueError("This code action has no workspace edit")
    changed = apply_workspace_edit(edit)
    for changed_path in changed:
        await _client(changed_path)
        await diagnostics(changed_path)
    return changed


async def shutdown_idle() -> int:
    now = time.monotonic()
    idle = [key for key, client in _clients.items() if now - client.last_activity >= IDLE_TIMEOUT_SECONDS]
    for key in idle:
        client = _clients.pop(key)
        await client.close()
    return len(idle)


async def shutdown() -> None:
    clients = list(_clients.values())
    _clients.clear()
    await asyncio.gather(*(client.close() for client in clients), return_exceptions=True)
