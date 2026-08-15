from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from rlm import lsp


class LspTest(unittest.TestCase):
    def test_applies_a_multifile_workspace_edit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first.py"
            second = root / "second.py"
            first.write_text("before\n", encoding="utf-8")
            second.write_text("before\n", encoding="utf-8")
            changed = lsp.apply_workspace_edit(
                {
                    "changes": {
                        lsp._uri(first): [{"range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 6}}, "newText": "after"}],
                        lsp._uri(second): [{"range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 6}}, "newText": "after"}],
                    }
                }
            )
            self.assertEqual({Path(path) for path in changed}, {first, second})
            self.assertEqual(first.read_text(encoding="utf-8"), "after\n")
            self.assertEqual(second.read_text(encoding="utf-8"), "after\n")

    def test_unavailable_server_has_a_clear_nonfatal_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "example.py"
            source.write_text("x = 1\n", encoding="utf-8")
            with patch.object(lsp, "_server_config", return_value={"command": "definitely-not-an-lsp-server", "args": []}):
                with self.assertRaisesRegex(lsp.LspUnavailableError, "was not found"):
                    asyncio.run(lsp._client(source))

    def test_rename_refreshes_diagnostics_for_every_changed_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first.py"
            second = root / "second.py"
            first.write_text("name = 1\n", encoding="utf-8")
            second.write_text("name\n", encoding="utf-8")
            client = type("Client", (), {"request": AsyncMock(return_value={"changes": {lsp._uri(first): [{"range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 4}}, "newText": "renamed"}], lsp._uri(second): [{"range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 4}}, "newText": "renamed"}]}})})()
            with patch.object(lsp, "_client", AsyncMock(side_effect=[(client, first, lsp._uri(first)), (client, first, lsp._uri(first)), (client, second, lsp._uri(second))])), patch.object(lsp, "diagnostics", AsyncMock()):
                changed = asyncio.run(lsp.rename(first, 0, 0, "renamed"))
            self.assertEqual(len(changed), 2)
            self.assertEqual(first.read_text(encoding="utf-8"), "renamed = 1\n")
            self.assertEqual(second.read_text(encoding="utf-8"), "renamed\n")

    def test_idle_clients_are_torn_down(self) -> None:
        client = type("Client", (), {"last_activity": 0, "close": AsyncMock()})()
        key = (Path.cwd(), "python")
        lsp._clients[key] = client
        with patch.object(lsp.time, "monotonic", return_value=lsp.IDLE_TIMEOUT_SECONDS + 1):
            self.assertEqual(asyncio.run(lsp.shutdown_idle()), 1)
        client.close.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
