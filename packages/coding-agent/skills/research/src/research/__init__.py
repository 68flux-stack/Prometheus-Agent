"""Deep research skill: an on-disk evidence ledger for multi-wave research runs.

The agent orchestrates; this module only does the bookkeeping that keeps a long
research run honest — deduplicating notes, counting how many independent sources
back each sub-question, and refusing to render a report whose citations do not
resolve to a page that was actually retrieved.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable

from .ledger import (
    EFFORT_TIERS,
    MARGINAL_YIELD_SOURCES,
    MAX_FAILED_CRITERIA,
    MIN_DOMAINS_PER_SUB_QUESTION,
    STANCES,
    ZERO_YIELD_ROUNDS_BEFORE_CONCEDING,
    Run,
    add_candidate,
    add_detail,
    add_note,
    concede as _concede,
    coverage as _coverage,
    create_run,
    evaluate_candidate,
    gaps as _gaps,
    next_round as _next_round,
    quota_status,
    register_source,
    render_report,
    resolve_run,
)

__all__ = [
    "EFFORT_TIERS",
    "MARGINAL_YIELD_SOURCES",
    "MAX_FAILED_CRITERIA",
    "MIN_DOMAINS_PER_SUB_QUESTION",
    "STANCES",
    "ZERO_YIELD_ROUNDS_BEFORE_CONCEDING",
    "candidate",
    "candidates",
    "concede",
    "coverage",
    "detail",
    "evaluate",
    "fetch",
    "gaps",
    "next_round",
    "note",
    "open_run",
    "qualified",
    "report",
    "run",
    "start",
    "status",
]

_active: Path | None = None


def _base() -> Path:
    return Path.cwd() / "research"


def _run(dir: str | Path | None) -> Run:
    return resolve_run(_base(), dir, _active)


#: Goal objectives are capped host-side (MAX_THREAD_GOAL_OBJECTIVE_CHARS in goals.ts).
_MAX_GOAL_OBJECTIVE_CHARS = 4000


def _build_goal_objective(question: str, meta: dict[str, Any], directory: str) -> str:
    criteria = meta.get("criteria", [])
    fields = meta.get("deep_dive_fields", [])
    objective = "\n".join(
        [
            f"Deliver {meta['quota']} candidates that pass every filtering criterion for: {question}",
            "",
            f"Ledger: {directory}",
            "",
            "Criteria (a candidate failing more than one is discarded):",
            *(f"- {criterion}" for criterion in criteria),
            "",
            *(["Every qualified candidate needs: " + ", ".join(fields), ""] if fields else []),
            "Completion contract:",
            f"- The run is complete only when `await research.status()` reports {meta['quota']} qualified"
            " candidates and `await research.report()` returns without raising.",
            "- Being short of the quota is not a reason to finish. Call `await research.next_round()`;"
            " it returns the source classes this round must use and every candidate rejected so far.",
            "- If the quota is genuinely unreachable, `await research.concede(reason)` records why."
            " It refuses until two consecutive rounds have produced nothing.",
            "- Do not call `goal.complete()` before `research.report()` has succeeded.",
        ]
    )
    return objective[:_MAX_GOAL_OBJECTIVE_CHARS]


async def _install_goal(question: str, meta: dict[str, Any], directory: str) -> dict[str, Any]:
    """Install the per-turn continuation that keeps a quota run going.

    An active thread goal is re-injected at every turn boundary along with the
    host's own "audit against every requirement before completing" prompt, which
    is what stops a quota from being quietly abandoned mid-run. A goal already in
    flight belongs to the user, so never replace it.
    """
    try:
        import goal
    except ImportError:
        return {"enforced": False, "reason": "the goal skill is not available in this session"}

    existing = (await goal.get()).get("goal")
    if existing and existing.get("status") in ("active", "paused", "budget_limited"):
        return {
            "enforced": False,
            "reason": (
                f"a thread goal is already active ({existing.get('objective', '')[:80]!r}). "
                "Run `/goal clear` and call research.start again for quota enforcement."
            ),
        }
    # token_budget is deliberately unset: a budget flips the goal to budget_limited
    # and steers a wrap-up prompt, which is the opposite of what a quota run needs.
    await goal.create(_build_goal_objective(question, meta, directory))
    return {"enforced": True}


async def start(
    question: str,
    sub_questions: Iterable[str],
    *,
    effort: str = "medium",
    quota: int | None = None,
    criteria: Iterable[str] | None = None,
    deep_dive_fields: Iterable[str] | None = None,
    source_policy: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Begin (or resume) a research run and return its directory and budget.

    Passing `quota` switches the run into quota mode: `sub_questions` become
    discovery vectors, candidates are filtered against `criteria`, and a thread
    goal is installed so the harness keeps the run going until the quota is met.

    Re-calling with the same question returns the existing run, so this is safe
    after compaction or a kernel restart.
    """
    global _active
    research_run = create_run(
        _base(),
        question,
        sub_questions,
        effort,
        quota=quota,
        criteria=criteria,
        deep_dive_fields=deep_dive_fields,
        source_policy=source_policy,
    )
    _active = research_run.dir
    meta = research_run.meta()
    result = {
        "dir": str(research_run.dir),
        "slug": research_run.slug,
        "sub_questions": meta["sub_questions"],
        "effort": meta["effort"],
        "children": meta["children"],
        "max_parallel": meta["max_parallel"],
        "waves": meta["waves"],
        "calls_per_child": meta["calls_per_child"],
    }
    if meta.get("quota") is not None:
        result["quota"] = meta["quota"]
        result["criteria"] = meta["criteria"]
        result["deep_dive_fields"] = meta["deep_dive_fields"]
        result["goal"] = await _install_goal(question, meta, str(research_run.dir))
    return result


async def open_run(dir: str | Path) -> dict[str, Any]:
    """Attach to an existing run — how a subagent joins its parent's ledger."""
    global _active
    research_run = _run(dir)
    _active = research_run.dir
    meta = research_run.meta()
    return {"dir": str(research_run.dir), "question": meta["question"], "sub_questions": meta["sub_questions"]}


async def fetch(
    urls: str | list[str],
    *,
    max_chars: int = 8000,
    dir: str | Path | None = None,
) -> str:
    """Read pages in full and register them as sources of the current run.

    This is the only way a URL becomes citable: `note` rejects any URL that was
    not retrieved here, so evidence always traces back to a page someone read.
    """
    try:
        import websearch
    except ImportError as error:  # pragma: no cover - depends on session config
        raise RuntimeError(
            "The websearch skill is not available in this session, so pages cannot be fetched. "
            'Enable it in settings ("bundledSkills": {"websearch": true}).'
        ) from error

    url_list = [urls] if isinstance(urls, str) else list(urls)
    research_run = _run(dir)
    text = await websearch.fetch(url_list, max_chars=max_chars)
    # websearch.fetch returns an error string rather than raising; a failed read
    # must not leave a citable source behind.
    failed = text.startswith("Error fetching ")
    for url in url_list:
        register_source(research_run, url, None, "error" if failed else "ok")
    if failed:
        raise RuntimeError(text)
    return text


async def note(
    sub_question: str,
    claim: str,
    url: str,
    quote: str,
    *,
    stance: str = "supports",
    dir: str | Path | None = None,
) -> dict[str, Any]:
    """Record one piece of evidence.

    `stance` is "supports", "contradicts", or "unverified" — a claim you could
    not check is reported as unverified, never silently dropped or asserted.
    """
    return add_note(_run(dir), sub_question, claim, url, quote, stance)


async def coverage(*, dir: str | Path | None = None) -> list[dict[str, Any]]:
    """Per sub-question: note count, distinct source domains, open conflicts."""
    return _coverage(_run(dir))


async def gaps(*, dir: str | Path | None = None) -> list[dict[str, Any]]:
    """Sub-questions still needing work. Empty means the run can stop."""
    return _gaps(_run(dir))


async def candidate(
    name: str,
    one_liner: str,
    vectors: Iterable[str],
    *,
    dir: str | Path | None = None,
) -> dict[str, Any]:
    """Register a candidate, refusing one already seen — including a rejected one.

    Raises on a near-duplicate, naming the earlier candidate and why it failed.
    """
    return add_candidate(_run(dir), name, one_liner, vectors)


async def evaluate(
    candidate_id: str,
    verdicts: dict[str, Any],
    *,
    dir: str | Path | None = None,
) -> dict[str, Any]:
    """Score a candidate against every criterion and let the ledger decide.

    `verdicts` maps each criterion to `{"pass": bool, "note": str, "url": str}`.
    A failing verdict needs a note; a cited URL must have been fetched. More than
    one failure discards the candidate — the threshold is applied here rather
    than judged in prose.
    """
    return evaluate_candidate(_run(dir), candidate_id, verdicts)


async def detail(
    candidate_id: str,
    field: str,
    content: str,
    *,
    dir: str | Path | None = None,
) -> dict[str, Any]:
    """Fill one required deep-dive field for a candidate."""
    return add_detail(_run(dir), candidate_id, field, content)


async def candidates(*, dir: str | Path | None = None) -> list[dict[str, Any]]:
    return _run(dir).candidates()


async def qualified(*, dir: str | Path | None = None) -> list[dict[str, Any]]:
    return [row for row in _run(dir).candidates() if row.get("status") == "qualified"]


async def next_round(*, dir: str | Path | None = None) -> dict[str, Any]:
    """Open the next discovery round and return the policy it must follow.

    Call this first on every continuation turn of a quota run: it returns the
    shortfall, the source classes this round is required to use, vectors and
    cross-pollinations not yet tried, and every rejection so far so the same idea
    is not rediscovered under a new name.
    """
    return _next_round(_run(dir))


async def concede(reason: str, *, dir: str | Path | None = None) -> dict[str, Any]:
    """Record that the quota is unreachable, so `report()` may render short.

    Refuses until the ledger shows two consecutive rounds that produced no
    qualified candidates — a stalled search has to be demonstrated, not asserted.
    """
    return _concede(_run(dir), reason)


async def status(*, dir: str | Path | None = None) -> dict[str, Any]:
    research_run = _run(dir)
    meta = research_run.meta()
    notes = research_run.notes()
    coverage = _coverage(research_run, notes)
    result = {
        "dir": str(research_run.dir),
        "question": meta["question"],
        "effort": meta["effort"],
        "sources": len(research_run.sources()),
        "notes": len(notes),
        "coverage": coverage,
        "gaps": _gaps(research_run, coverage),
    }
    if meta.get("quota") is not None:
        result["quota_status"] = quota_status(research_run)
    return result


async def report(title: str | None = None, *, dir: str | Path | None = None) -> str:
    """Render and write report.md, verifying every citation first.

    Raises if a claim cites a URL that was never retrieved.
    """
    return render_report(_run(dir), title)


async def run(
    question: str,
    sub_questions: Iterable[str],
    *,
    effort: str = "medium",
    quota: int | None = None,
    criteria: Iterable[str] | None = None,
    deep_dive_fields: Iterable[str] | None = None,
    source_policy: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Default entry point — same as `start`."""
    return await start(
        question,
        sub_questions,
        effort=effort,
        quota=quota,
        criteria=criteria,
        deep_dive_fields=deep_dive_fields,
        source_policy=source_policy,
    )
