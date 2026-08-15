"""Ripgrep-backed content search for the agent kernel.

Hand-rolled ``Path.rglob`` + ``read_text`` scans are the standard way a cell
wedges the kernel: they descend into ``node_modules`` and ``.git``, read build
artifacts that are hundreds of megabytes, and hold every match in memory. rg
already solves all of that (parallel walk, gitignore-aware, binary detection),
and the host ships it as a managed binary — so the kernel just drives it.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

DEFAULT_LIMIT = 200
DEFAULT_MAX_COLUMNS = 400
FIELD_SEPARATOR = "\x1f"


@dataclass(frozen=True)
class SearchMatch:
    path: str
    line: int
    text: str

    def __str__(self) -> str:
        return f"{self.path}:{self.line}: {self.text}"


class RipgrepUnavailableError(RuntimeError):
    """Raised when no rg binary can be found for this kernel."""


def _agent_bin_dir() -> Path:
    configured = os.environ.get("PROMETHEUS_CODING_AGENT_DIR")
    root = Path(configured).expanduser() if configured else Path.home() / ".prime" / "agent"
    return root / "bin"


def ripgrep_path() -> str:
    """Locate rg: PATH first, then the host's managed bin directory."""
    found = shutil.which("rg")
    if found:
        return found
    managed = _agent_bin_dir() / ("rg.exe" if os.name == "nt" else "rg")
    if managed.exists():
        return str(managed)
    raise RipgrepUnavailableError(
        "ripgrep (rg) was not found on PATH or in the Prometheus bin directory. "
        "Install it from https://github.com/BurntSushi/ripgrep#installation."
    )


def search(
    pattern: str,
    path: str | os.PathLike[str] = ".",
    *,
    glob: str | list[str] | None = None,
    ignore_case: bool = False,
    fixed: bool = False,
    files_only: bool = False,
    hidden: bool = False,
    no_ignore: bool = False,
    limit: int = DEFAULT_LIMIT,
) -> list[SearchMatch] | list[str]:
    """Search file contents under ``path`` and return at most ``limit`` results.

    ``pattern`` is a regex unless ``fixed=True``. ``glob`` filters paths the way
    ``rg --glob`` does ("*.ts", "!test/**"). ``files_only=True`` returns matching
    paths instead of matches. Results stop at ``limit``; rg is killed at that
    point, so a broad pattern over a huge tree still returns promptly.

    >>> search("BrowserWindow", glob="*.cjs")[:1]
    """
    if not isinstance(pattern, str) or not pattern:
        raise ValueError("pattern must be a non-empty str")
    if limit <= 0:
        raise ValueError("limit must be positive")

    # --no-require-git: rg only honours .gitignore inside a repository by default,
    # and an agent workspace is often not one.
    argv = [ripgrep_path(), "--color", "never", "--no-require-git"]
    if files_only:
        argv.append("--files-with-matches")
    else:
        argv += [
            "--line-number",
            "--no-heading",
            "--max-columns",
            str(DEFAULT_MAX_COLUMNS),
            # Splitting rg's default "path:line:text" on ":" breaks on Windows
            # drive letters (and on any path containing a colon).
            "--field-match-separator",
            FIELD_SEPARATOR,
        ]
    if ignore_case:
        argv.append("--ignore-case")
    if fixed:
        argv.append("--fixed-strings")
    if hidden:
        argv.append("--hidden")
    if no_ignore:
        argv.append("--no-ignore")
    for pattern_glob in [glob] if isinstance(glob, str) else (glob or []):
        argv += ["--glob", pattern_glob]
    argv += ["--regexp", pattern, "--", os.fspath(path)]

    results: list[SearchMatch] | list[str] = []
    process = subprocess.Popen(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    try:
        assert process.stdout is not None
        for raw in process.stdout:
            line = raw.rstrip("\n")
            if not line:
                continue
            if files_only:
                results.append(line)  # type: ignore[arg-type]
            else:
                parts = line.split(FIELD_SEPARATOR, 2)
                if len(parts) < 3 or not parts[1].isdigit():
                    continue
                results.append(SearchMatch(parts[0], int(parts[1]), parts[2]))  # type: ignore[arg-type]
            if len(results) >= limit:
                process.terminate()
                break
    finally:
        if process.stdout is not None:
            process.stdout.close()
        stderr = process.stderr.read() if process.stderr is not None else ""
        if process.stderr is not None:
            process.stderr.close()
        code = process.wait()

    # 0 = matched, 1 = no match, 2 = partial (unreadable paths) — only a hard
    # failure with nothing collected is worth raising on.
    if code not in (0, 1, 2) and not results:
        raise RuntimeError(f"ripgrep failed ({code}): {stderr.strip() or 'no output'}")
    return results
