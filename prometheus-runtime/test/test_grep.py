import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from rlm.grep import RipgrepUnavailableError, SearchMatch, ripgrep_path, search  # noqa: E402


def _has_ripgrep() -> bool:
    try:
        ripgrep_path()
    except RipgrepUnavailableError:
        return False
    return True


@unittest.skipUnless(_has_ripgrep(), "ripgrep is not installed")
class SearchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="rlm-grep-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        (self.root / "app.js").write_text("const win = new BrowserWindow({})\n", encoding="utf-8")
        (self.root / "notes.md").write_text("browserwindow in prose\n", encoding="utf-8")
        (self.root / "node_modules" / "dep").mkdir(parents=True)
        (self.root / "node_modules" / "dep" / "index.js").write_text("BrowserWindow\n", encoding="utf-8")
        (self.root / ".gitignore").write_text("ignored/\nnode_modules/\n", encoding="utf-8")
        (self.root / "ignored").mkdir()
        (self.root / "ignored" / "out.js").write_text("BrowserWindow\n", encoding="utf-8")

    def test_returns_matches_and_skips_dependencies_and_ignored_paths(self) -> None:
        hits = search("BrowserWindow", self.root)

        self.assertEqual([Path(hit.path).name for hit in hits], ["app.js"])
        self.assertEqual(hits[0].line, 1)
        self.assertIn("BrowserWindow", hits[0].text)
        self.assertIsInstance(hits[0], SearchMatch)

    def test_ignore_case_glob_and_files_only(self) -> None:
        self.assertEqual(len(search("browserwindow", self.root, ignore_case=True)), 2)
        self.assertEqual(len(search("BrowserWindow", self.root, glob="*.md")), 0)
        self.assertEqual([Path(p).name for p in search("BrowserWindow", self.root, files_only=True)], ["app.js"])

    def test_limit_truncates_without_reading_the_rest(self) -> None:
        big = self.root / "many.txt"
        big.write_text("needle\n" * 5000, encoding="utf-8")

        hits = search("needle", self.root, limit=5)

        self.assertEqual(len(hits), 5)

    def test_no_match_is_empty_not_an_error(self) -> None:
        self.assertEqual(search("definitely-not-present-anywhere", self.root), [])

    def test_rejects_an_empty_pattern(self) -> None:
        with self.assertRaises(ValueError):
            search("", self.root)


if __name__ == "__main__":
    unittest.main()
