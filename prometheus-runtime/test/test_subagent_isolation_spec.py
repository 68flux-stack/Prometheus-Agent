from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from rlm.harness import HarnessState


class SubagentIsolationSpecTest(unittest.TestCase):
    def test_subagent_specs_store_and_update_isolation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            created = state.create_subagent("Editor", "Modify the code", isolation="worktree")
            self.assertEqual(created.metadata["isolation"], "worktree")

            updated = state.update_subagent(created.id, "Editor", "Inspect only", isolation="none")
            self.assertEqual(updated.metadata["isolation"], "none")

    def test_subagent_specs_reject_unknown_isolation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            with self.assertRaisesRegex(ValueError, "isolation"):
                state.create_subagent("Editor", "Modify the code", isolation="container")


if __name__ == "__main__":
    unittest.main()
