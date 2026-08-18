"""Evidence ledger for deep research runs.

Everything a research run learns lives on disk under ``<cwd>/research/<slug>/``,
not in the agent's context window: notes, the sources they came from, and the
rendered report. The agent (and its subagents) append to the ledger as they go
and read coverage back out of it, so a long run survives compaction, kernel
restarts, and the fact that subagents have their own separate contexts.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit

EFFORT_TIERS: dict[str, dict[str, int]] = {
    # children: total across the whole run; max_parallel: per wave, because
    # RlmTreeLimitCoordinator.admit() throws rather than queues once
    # RLM_MAX_CONCURRENT_CHILDREN (default 4) is reached.
    "low": {"children": 0, "max_parallel": 0, "waves": 1, "calls_per_child": 10},
    "medium": {"children": 4, "max_parallel": 4, "waves": 2, "calls_per_child": 15},
    "high": {"children": 12, "max_parallel": 4, "waves": 3, "calls_per_child": 15},
}

STANCES = ("supports", "contradicts", "unverified")

#: A claim counts as corroborated at this many distinct source domains.
MIN_DOMAINS_PER_SUB_QUESTION = 2

#: A wave that adds fewer than this many new sources has hit diminishing returns.
MARGINAL_YIELD_SOURCES = 3

#: A candidate is discarded once it fails more than this many filtering criteria.
MAX_FAILED_CRITERIA = 1

#: Name+summary overlap above this fraction is treated as the same idea reworded.
NEAR_DUPLICATE_SIMILARITY = 0.6

#: Consecutive zero-yield rounds required before a shortfall may be conceded.
ZERO_YIELD_ROUNDS_BEFORE_CONCEDING = 2

CANDIDATE_STATUSES = ("open", "qualified", "rejected")

# ponytail: two-label domains plus a short public-suffix list, not the full PSL.
# Good enough to stop "three pages on one site" counting as three sources; add
# tldextract only if real queries start tripping over it.
_MULTI_LABEL_SUFFIXES = frozenset(
    {
        "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "or.jp", "ne.jp",
        "com.au", "net.au", "org.au", "co.nz", "com.br", "com.cn", "co.in",
        "co.za", "com.mx", "com.sg", "co.kr",
    }
)

# Hosts where each subdomain is a different author, so collapsing them would
# overstate source diversity.
_PER_SUBDOMAIN_HOSTS = frozenset(
    {"github.io", "substack.com", "medium.com", "wordpress.com", "blogspot.com", "readthedocs.io"}
)


def registrable_domain(url: str) -> str:
    """Return the owner-level domain of a URL, for source-diversity counting."""
    host = (urlsplit(url).hostname or "").lower().strip(".")
    if not host:
        return ""
    labels = host.split(".")
    if len(labels) <= 2:
        return host
    last_two = ".".join(labels[-2:])
    if last_two in _PER_SUBDOMAIN_HOSTS:
        return ".".join(labels[-3:])
    if last_two in _MULTI_LABEL_SUFFIXES and len(labels) >= 3:
        return ".".join(labels[-3:])
    return last_two


def slugify(text: str, *, max_length: int = 48) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:max_length].strip("-") or "research"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue  # A torn final line must not destroy the rest of the ledger.
        if isinstance(row, dict):
            rows.append(row)
    return rows


def _append_jsonl(path: Path, row: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")


@dataclass(frozen=True)
class Run:
    """One research run, identified by its directory."""

    dir: Path

    @property
    def slug(self) -> str:
        return self.dir.name

    @property
    def notes_path(self) -> Path:
        return self.dir / "notes.jsonl"

    @property
    def sources_path(self) -> Path:
        return self.dir / "sources.jsonl"

    @property
    def candidates_path(self) -> Path:
        return self.dir / "candidates.jsonl"

    @property
    def question_path(self) -> Path:
        return self.dir / "question.md"

    @property
    def report_path(self) -> Path:
        return self.dir / "report.md"

    @property
    def meta_path(self) -> Path:
        return self.dir / "meta.json"

    def meta(self) -> dict[str, Any]:
        if not self.meta_path.exists():
            raise FileNotFoundError(f"{self.dir} is not a research run (no meta.json)")
        return json.loads(self.meta_path.read_text(encoding="utf-8"))

    @property
    def rounds_path(self) -> Path:
        return self.dir / "rounds.jsonl"

    def notes(self) -> list[dict[str, Any]]:
        return _read_jsonl(self.notes_path)

    def sources(self) -> list[dict[str, Any]]:
        return _read_jsonl(self.sources_path)

    def candidates(self) -> list[dict[str, Any]]:
        """Fold the append-only candidate log; a later row for an id replaces it.

        Appending rather than rewriting keeps concurrent subagents from clobbering
        each other's writes.
        """
        folded: dict[str, dict[str, Any]] = {}
        for row in _read_jsonl(self.candidates_path):
            candidate_id = row.get("id")
            if not isinstance(candidate_id, str):
                continue
            folded[candidate_id] = {**folded.get(candidate_id, {}), **row}
        return list(folded.values())

    def rounds(self) -> list[dict[str, Any]]:
        return _read_jsonl(self.rounds_path)

    def current_round(self) -> int:
        rounds = self.rounds()
        return max((row.get("round", 1) for row in rounds), default=1)


def resolve_run(base: Path, dir: str | Path | None, active: Path | None) -> Run:
    """Pick the run to act on: explicit dir, then the session's active run, then
    the most recently touched run under ``<cwd>/research/``."""
    if dir is not None:
        path = Path(dir).expanduser()
        if not path.is_absolute():
            path = (Path.cwd() / path).resolve()
        if not path.exists():
            raise FileNotFoundError(f"No research run at {path}")
        return Run(path)
    if active is not None and active.exists():
        return Run(active)
    candidates = [child for child in base.glob("*/meta.json")]
    if not candidates:
        raise FileNotFoundError(
            f"No research run found under {base}. Call research.start(...) first, or pass dir=..."
        )
    newest = max(candidates, key=lambda p: p.stat().st_mtime)
    return Run(newest.parent)


def _clean_list(values: Iterable[str] | None, label: str, *, unique: bool = True) -> list[str]:
    items = [value.strip() for value in (values or []) if value and value.strip()]
    if unique and len(items) != len(set(items)):
        raise ValueError(f"{label} must be unique")
    return items


def create_run(
    base: Path,
    question: str,
    sub_questions: Iterable[str],
    effort: str,
    *,
    quota: int | None = None,
    criteria: Iterable[str] | None = None,
    deep_dive_fields: Iterable[str] | None = None,
    source_policy: Iterable[str] | None = None,
) -> Run:
    if effort not in EFFORT_TIERS:
        raise ValueError(f"effort must be one of {', '.join(EFFORT_TIERS)}")
    subs = [s.strip() for s in sub_questions if s and s.strip()]
    if not subs:
        raise ValueError("sub_questions must contain at least one non-empty sub-question")
    if len(subs) != len(set(subs)):
        raise ValueError("sub_questions must be unique — overlapping briefs cause duplicate work")

    criteria_list = _clean_list(criteria, "criteria")
    fields_list = _clean_list(deep_dive_fields, "deep_dive_fields")
    policy_list = _clean_list(source_policy, "source_policy")
    if quota is not None:
        if not isinstance(quota, int) or isinstance(quota, bool) or quota < 1:
            raise ValueError("quota must be a positive integer")
        if not criteria_list:
            raise ValueError("a quota run needs criteria — otherwise nothing decides what qualifies")

    base.mkdir(parents=True, exist_ok=True)
    slug = slugify(question)
    directory = base / slug
    suffix = 2
    while directory.exists() and (directory / "meta.json").exists():
        existing = json.loads((directory / "meta.json").read_text(encoding="utf-8"))
        if existing.get("question") == question:
            return Run(directory)  # Idempotent: re-entry after compaction resumes.
        directory = base / f"{slug}-{suffix}"
        suffix += 1
    directory.mkdir(parents=True, exist_ok=True)

    run = Run(directory)
    tier = EFFORT_TIERS[effort]
    run.meta_path.write_text(
        json.dumps(
            {
                "question": question,
                "sub_questions": subs,
                "effort": effort,
                "created_at": _now(),
                "quota": quota,
                "criteria": criteria_list,
                "deep_dive_fields": fields_list,
                "source_policy": policy_list,
                **tier,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    lines = [
        f"# {question}",
        "",
        f"Effort: {effort} (up to {tier['children']} subagents, "
        f"{tier['max_parallel']} per wave, {tier['waves']} waves)",
        "",
        "## Sub-questions" if quota is None else "## Discovery vectors",
        "",
        *(f"{i}. {sub}" for i, sub in enumerate(subs, 1)),
        "",
    ]
    if quota is not None:
        lines += [
            f"## Quota: {quota} candidates passing every criterion",
            "",
            "### Filtering criteria",
            "",
            *(f"- {criterion}" for criterion in criteria_list),
            "",
        ]
        if fields_list:
            lines += ["### Required deep-dive fields", "", *(f"- {field}" for field in fields_list), ""]
        if policy_list:
            lines += ["### Source-class rotation", "", *(f"{i}. {p}" for i, p in enumerate(policy_list, 1)), ""]
    run.question_path.write_text("\n".join(lines), encoding="utf-8")
    if quota is not None:
        # Round one consumes the first source class so later rounds are forced onto
        # the ones it did not touch.
        start_round(run, policy_list[:1])
    return run


def register_source(run: Run, url: str, title: str | None, status: str) -> dict[str, Any]:
    """Record a URL that was actually retrieved. Re-registering updates nothing."""
    existing = {row["url"]: row for row in run.sources() if "url" in row}
    if url in existing:
        return existing[url]
    row = {
        "id": len(existing) + 1,
        "url": url,
        "domain": registrable_domain(url),
        "title": title or "",
        "status": status,
        "retrieved_at": _now(),
    }
    _append_jsonl(run.sources_path, row)
    return row


def add_note(
    run: Run,
    sub_question: str,
    claim: str,
    url: str,
    quote: str,
    stance: str,
) -> dict[str, Any]:
    if stance not in STANCES:
        raise ValueError(f"stance must be one of {', '.join(STANCES)}")
    for name, value in (("sub_question", sub_question), ("claim", claim), ("url", url), ("quote", quote)):
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{name} must be a non-empty string")

    known = {row.get("url") for row in run.sources()}
    if url not in known:
        raise ValueError(
            f"{url} has not been read. Fetch it with research.fetch(url) before taking a note from it — "
            "search highlights are not evidence."
        )

    subs = run.meta().get("sub_questions", [])
    if subs and sub_question not in subs:
        raise ValueError(f"Unknown sub-question {sub_question!r}. Known: {subs}")

    digest = hashlib.sha1(f"{url}\n{quote.strip()}".encode("utf-8")).hexdigest()
    if any(row.get("digest") == digest for row in run.notes()):
        return {"duplicate": True, "digest": digest}

    row = {
        "digest": digest,
        "sub_question": sub_question,
        "claim": claim.strip(),
        "stance": stance,
        "url": url,
        "domain": registrable_domain(url),
        "quote": quote.strip(),
        "recorded_at": _now(),
    }
    _append_jsonl(run.notes_path, row)
    return row


# --- Quota mode: candidates, criteria verdicts, rounds -----------------------

_STOPWORDS = frozenset(
    {
        "a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with",
        "software", "platform", "tool", "tools", "app", "saas", "system", "management",
    }
)


def _stem(token: str) -> str:
    """Crude singularization so "hatcheries" and "hatchery" compare equal."""
    if len(token) > 4 and token.endswith("ies"):
        return f"{token[:-3]}y"
    if len(token) > 3 and token.endswith("s") and not token.endswith("ss"):
        return token[:-1]
    return token


def _tokens(text: str) -> set[str]:
    return {_stem(token) for token in re.findall(r"[a-z0-9]+", text.lower()) if token not in _STOPWORDS}


def similarity(left: str, right: str) -> float:
    """Jaccard overlap of significant words.

    ponytail: lexical, not semantic. It catches an idea resubmitted in different
    words, which is the failure the rejection log exists to prevent; it will not
    catch two genuinely different phrasings of the same concept. Reach for
    embeddings only if real runs show duplicates slipping through.
    """
    a, b = _tokens(left), _tokens(right)
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def start_round(run: Run, source_classes: Iterable[str] | None = None) -> dict[str, Any]:
    """Open a new discovery round and record which source classes it must use."""
    rounds = run.rounds()
    number = max((row.get("round", 0) for row in rounds), default=0) + 1
    row = {
        "round": number,
        "source_classes": _clean_list(source_classes, "source_classes"),
        "qualified_at_start": sum(1 for c in run.candidates() if c.get("status") == "qualified"),
        "started_at": _now(),
    }
    _append_jsonl(run.rounds_path, row)
    return row


def round_yield(run: Run) -> list[dict[str, Any]]:
    """Qualified candidates produced per round, in round order."""
    candidates = run.candidates()
    result = []
    for row in sorted(run.rounds(), key=lambda r: r.get("round", 0)):
        number = row.get("round", 0)
        in_round = [c for c in candidates if c.get("round") == number]
        result.append(
            {
                "round": number,
                "source_classes": row.get("source_classes", []),
                "registered": len(in_round),
                "qualified": sum(1 for c in in_round if c.get("status") == "qualified"),
                "rejected": sum(1 for c in in_round if c.get("status") == "rejected"),
            }
        )
    return result


def add_candidate(run: Run, name: str, one_liner: str, vectors: Iterable[str]) -> dict[str, Any]:
    """Register a candidate, refusing an idea already seen — including a rejected one."""
    for label, value in (("name", name), ("one_liner", one_liner)):
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{label} must be a non-empty string")

    text = f"{name} {one_liner}"
    for existing in run.candidates():
        score = similarity(text, f"{existing.get('name', '')} {existing.get('one_liner', '')}")
        if score >= NEAR_DUPLICATE_SIMILARITY:
            reason = existing.get("rejected_reason") or existing.get("status", "open")
            raise ValueError(
                f"{name!r} duplicates {existing['id']} ({existing.get('name')!r}, {score:.0%} overlap, {reason}). "
                "Review research.next_round()['rejections'] before proposing candidates."
            )

    candidate_id = f"c{len(run.candidates()) + 1}"
    row = {
        "id": candidate_id,
        "name": name.strip(),
        "one_liner": one_liner.strip(),
        "vectors": _clean_list(vectors, "vectors"),
        "round": run.current_round(),
        "status": "open",
        "verdicts": {},
        "details": {},
        "registered_at": _now(),
    }
    _append_jsonl(run.candidates_path, row)
    return row


def _require_candidate(run: Run, candidate_id: str) -> dict[str, Any]:
    for row in run.candidates():
        if row.get("id") == candidate_id:
            return row
    raise ValueError(f"Unknown candidate {candidate_id!r}")


def evaluate_candidate(run: Run, candidate_id: str, verdicts: dict[str, Any]) -> dict[str, Any]:
    """Apply the filtering criteria mechanically: more than one failure discards."""
    candidate = _require_candidate(run, candidate_id)
    criteria = run.meta().get("criteria", [])
    if not criteria:
        raise ValueError("This run has no criteria; evaluate() only applies to a quota run")

    missing = [criterion for criterion in criteria if criterion not in verdicts]
    if missing:
        raise ValueError(f"Missing a verdict for: {', '.join(missing)}")
    unknown = [key for key in verdicts if key not in criteria]
    if unknown:
        raise ValueError(f"Unknown criteria: {', '.join(unknown)}")

    known_sources = {row.get("url") for row in run.sources() if row.get("status") == "ok"}
    normalized: dict[str, Any] = {}
    failed: list[str] = []
    for criterion in criteria:
        verdict = verdicts[criterion]
        if not isinstance(verdict, dict) or "pass" not in verdict:
            raise ValueError(f"Verdict for {criterion!r} must be a dict with a 'pass' key")
        passed = bool(verdict["pass"])
        note = str(verdict.get("note", "")).strip()
        url = verdict.get("url")
        if not passed and not note:
            raise ValueError(f"A failing verdict for {criterion!r} must carry a note saying why")
        if url and url not in known_sources:
            raise ValueError(
                f"Verdict for {criterion!r} cites {url}, which was never retrieved. "
                "Fetch it with research.fetch(url) first."
            )
        normalized[criterion] = {"pass": passed, "note": note, "url": url or ""}
        if not passed:
            failed.append(criterion)

    status = "rejected" if len(failed) > MAX_FAILED_CRITERIA else "qualified"
    row = {
        "id": candidate_id,
        "status": status,
        "verdicts": normalized,
        "failed_criteria": failed,
        "rejected_reason": f"failed {', '.join(failed)}" if status == "rejected" else "",
        "evaluated_at": _now(),
    }
    _append_jsonl(run.candidates_path, row)
    return {**candidate, **row}


def add_detail(run: Run, candidate_id: str, field: str, content: str) -> dict[str, Any]:
    candidate = _require_candidate(run, candidate_id)
    fields = run.meta().get("deep_dive_fields", [])
    if fields and field not in fields:
        raise ValueError(f"Unknown deep-dive field {field!r}. Expected one of: {', '.join(fields)}")
    if not isinstance(content, str) or not content.strip():
        raise ValueError("content must be a non-empty string")
    details = {**candidate.get("details", {}), field: content.strip()}
    row = {"id": candidate_id, "details": details, "updated_at": _now()}
    _append_jsonl(run.candidates_path, row)
    return {**candidate, **row}


def quota_status(run: Run) -> dict[str, Any]:
    meta = run.meta()
    quota = meta.get("quota")
    candidates = run.candidates()
    qualified = [c for c in candidates if c.get("status") == "qualified"]
    rejected = [c for c in candidates if c.get("status") == "rejected"]

    tallies: dict[str, int] = {}
    for candidate in rejected:
        for criterion in candidate.get("failed_criteria", []):
            tallies[criterion] = tallies.get(criterion, 0) + 1

    fields = meta.get("deep_dive_fields", [])
    incomplete = [
        {"id": c["id"], "name": c.get("name", ""), "missing": [f for f in fields if not c.get("details", {}).get(f)]}
        for c in qualified
        if any(not c.get("details", {}).get(field) for field in fields)
    ]
    return {
        "quota": quota,
        "qualified": len(qualified),
        "rejected": len(rejected),
        "open": sum(1 for c in candidates if c.get("status") == "open"),
        "shortfall": max(0, quota - len(qualified)) if quota else 0,
        "rejections_by_criterion": dict(sorted(tallies.items(), key=lambda kv: -kv[1])),
        "rounds": round_yield(run),
        "incomplete_deep_dives": incomplete,
        "conceded": meta.get("conceded"),
    }


def next_round(run: Run) -> dict[str, Any]:
    """Open the next round and hand back the policy for it, just in time.

    Phase-3-style rules only fire if they arrive when they are needed. Returning
    them as data at the round boundary beats restating them in a prompt the model
    read a hundred thousand tokens ago.
    """
    meta = run.meta()
    status = quota_status(run)
    if status["quota"] is None:
        raise ValueError("next_round() only applies to a quota run")

    used: set[str] = set()
    for row in run.rounds():
        used.update(row.get("source_classes", []))
    policy = meta.get("source_policy", [])
    unused = [source for source in policy if source not in used]
    if policy and not unused:
        raise ValueError(
            "Every source class in source_policy has been used. Add new source classes to the run "
            "or concede the shortfall with research.concede(reason)."
        )
    # One class per round: rotating forces a genuinely different search rather than
    # rerunning the previous round's sources with new wording.
    mandated = unused[:1]

    candidates = run.candidates()
    covered_vectors = {vector for c in candidates for vector in c.get("vectors", [])}
    vectors = meta.get("sub_questions", [])
    untried = [vector for vector in vectors if vector not in covered_vectors]
    pairs = [
        f"{a} x {b}"
        for index, a in enumerate(vectors)
        for b in vectors[index + 1 :]
        if not any({a, b} <= set(c.get("vectors", [])) for c in candidates)
    ]

    opened = start_round(run, mandated)
    return {
        "round": opened["round"],
        "qualified": status["qualified"],
        "quota": status["quota"],
        "shortfall": status["shortfall"],
        "mandated_source_classes": mandated,
        "remaining_source_classes": unused[1:],
        "already_used_source_classes": sorted(used),
        "untried_vectors": untried,
        "untried_cross_pollinations": pairs[:10],
        "rejections_by_criterion": status["rejections_by_criterion"],
        "rejections": [
            {"id": c["id"], "name": c.get("name", ""), "reason": c.get("rejected_reason", "")}
            for c in candidates
            if c.get("status") == "rejected"
        ],
        "previous_rounds": status["rounds"],
    }


def may_concede(run: Run) -> tuple[bool, str]:
    """A shortfall may only be conceded once the ledger shows the search stalled."""
    status = quota_status(run)
    if status["quota"] is None:
        return False, "This run has no quota to concede."
    if status["shortfall"] == 0:
        return False, "The quota is already met."
    if not any(c.get("status") == "rejected" for c in run.candidates()):
        return False, "Nothing has been rejected yet, so the search has not been narrow enough to stall."
    rounds = status["rounds"]
    # The opening round plus at least ZERO_YIELD_ROUNDS_BEFORE_CONCEDING further
    # attempts, so a shortfall can never be conceded straight out of round one.
    if len(rounds) <= ZERO_YIELD_ROUNDS_BEFORE_CONCEDING:
        return False, (
            f"Only {len(rounds)} round(s) have run. Call research.next_round() and search the source "
            "classes this run has not used yet."
        )
    trailing_zero = 0
    for row in reversed(rounds):
        if row["qualified"] == 0:
            trailing_zero += 1
        else:
            break
    if trailing_zero < ZERO_YIELD_ROUNDS_BEFORE_CONCEDING:
        return False, (
            f"Only {trailing_zero} consecutive round(s) produced zero qualified candidates; "
            f"{ZERO_YIELD_ROUNDS_BEFORE_CONCEDING} are required. Run another round with new source classes."
        )
    return True, ""


def concede(run: Run, reason: str) -> dict[str, Any]:
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError("concede requires a reason")
    allowed, why = may_concede(run)
    if not allowed:
        raise ValueError(why)
    meta = run.meta()
    meta["conceded"] = {"reason": reason.strip(), "at": _now(), "qualified": quota_status(run)["qualified"]}
    run.meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta["conceded"]


def coverage(run: Run) -> list[dict[str, Any]]:
    notes = run.notes()
    result = []
    for sub in run.meta().get("sub_questions", []):
        relevant = [note for note in notes if note.get("sub_question") == sub]
        domains = sorted({note.get("domain", "") for note in relevant if note.get("domain")})
        result.append(
            {
                "sub_question": sub,
                "notes": len(relevant),
                "domains": domains,
                "distinct_domains": len(domains),
                "contradictions": sum(1 for note in relevant if note.get("stance") == "contradicts"),
                "unverified": sum(1 for note in relevant if note.get("stance") == "unverified"),
                "corroborated": len(domains) >= MIN_DOMAINS_PER_SUB_QUESTION,
            }
        )
    return result


def gaps(run: Run) -> list[dict[str, Any]]:
    """Sub-questions that still need work: thin sourcing, or an open conflict."""
    open_gaps = []
    for entry in coverage(run):
        reasons = []
        if entry["distinct_domains"] < MIN_DOMAINS_PER_SUB_QUESTION:
            reasons.append(
                f"only {entry['distinct_domains']} distinct source domain(s), need {MIN_DOMAINS_PER_SUB_QUESTION}"
            )
        if entry["contradictions"] and entry["distinct_domains"] < MIN_DOMAINS_PER_SUB_QUESTION + 1:
            reasons.append("sources disagree and there is no third source to break the tie")
        if reasons:
            open_gaps.append({"sub_question": entry["sub_question"], "reasons": reasons})
    return open_gaps


def _render_quota_section(run: Run, status: dict[str, Any], numbering: dict[str, int]) -> list[str]:
    """Candidate table, deep dives, and — when short — the evidence that the search was real."""
    meta = run.meta()
    candidates = run.candidates()
    qualified = [c for c in candidates if c.get("status") == "qualified"]
    rejected = [c for c in candidates if c.get("status") == "rejected"]
    lines: list[str] = []

    conceded = status["conceded"]
    if conceded:
        lines += [
            f"> **Short of quota: {status['qualified']} of {status['quota']}.** {conceded['reason']}",
            ">",
            "> The rejection log and per-round yield below are the record of what was searched and why"
            " each rejected candidate failed.",
            "",
        ]

    lines += [
        f"## Qualified candidates ({len(qualified)}/{status['quota']})",
        "",
        "| # | Candidate | What it is | Round | Vectors |",
        "|---|---|---|---|---|",
    ]
    for index, candidate in enumerate(qualified, 1):
        vectors = ", ".join(candidate.get("vectors", []))
        lines.append(
            f"| {index} | {candidate.get('name', '')} | {candidate.get('one_liner', '')} "
            f"| {candidate.get('round', '')} | {vectors} |"
        )
    lines.append("")

    fields = meta.get("deep_dive_fields", [])
    for candidate in qualified:
        lines += [f"### {candidate.get('name', candidate['id'])}", "", candidate.get("one_liner", ""), ""]
        for field in fields:
            content = candidate.get("details", {}).get(field)
            if content:
                lines += [f"**{field}**", "", content, ""]
        verdict_rows = [
            f"- {criterion}: {'pass' if verdict.get('pass') else 'FAIL'}"
            + (f" — {verdict['note']}" if verdict.get("note") else "")
            + (f" [{numbering[verdict['url']]}]" if verdict.get("url") in numbering else "")
            for criterion, verdict in candidate.get("verdicts", {}).items()
        ]
        if verdict_rows:
            lines += ["**Criteria**", "", *verdict_rows, ""]

    if rejected:
        lines += [
            f"## Rejected ({len(rejected)})",
            "",
            "| Candidate | Round | Why |",
            "|---|---|---|",
            *(
                f"| {c.get('name', '')} | {c.get('round', '')} | {c.get('rejected_reason', '')} |"
                for c in rejected
            ),
            "",
        ]

    if status["rounds"]:
        lines += [
            "## Search rounds",
            "",
            "| Round | Source classes | Registered | Qualified | Rejected |",
            "|---|---|---|---|---|",
            *(
                f"| {r['round']} | {', '.join(r['source_classes']) or '—'} | {r['registered']} "
                f"| {r['qualified']} | {r['rejected']} |"
                for r in status["rounds"]
            ),
            "",
        ]
    return lines


def render_report(run: Run, title: str | None) -> str:
    """Render report.md, refusing to write a report whose citations do not resolve."""
    meta = run.meta()
    notes = run.notes()
    if not notes:
        raise ValueError("No notes recorded — nothing to report.")

    quota = meta.get("quota")
    status = quota_status(run) if quota is not None else None
    if status is not None and status["conceded"] is None:
        if status["shortfall"] > 0:
            top = ", ".join(f"{k} ({v})" for k, v in list(status["rejections_by_criterion"].items())[:3])
            raise ValueError(
                f"Refusing to render: {status['qualified']}/{quota} candidates qualify, "
                f"{status['shortfall']} short. Run another round — call research.next_round() for the "
                f"mandated source classes and the rejection log."
                + (f" Most rejections came from: {top}." if top else "")
                + " If the quota is genuinely unreachable, research.concede(reason) will say so on the record."
            )
        if status["incomplete_deep_dives"]:
            missing = "; ".join(
                f"{entry['name'] or entry['id']} is missing {', '.join(entry['missing'])}"
                for entry in status["incomplete_deep_dives"][:5]
            )
            raise ValueError(f"Refusing to render: qualified candidates have incomplete deep dives — {missing}")

    sources = {row["url"]: row for row in run.sources() if "url" in row}
    dangling = sorted({note["url"] for note in notes if note.get("url") not in sources})
    if dangling:
        raise ValueError(
            "Refusing to render: these cited URLs are not in sources.jsonl, so they were never "
            f"retrieved: {', '.join(dangling)}"
        )
    unretrieved = sorted(
        {note["url"] for note in notes if sources.get(note["url"], {}).get("status") != "ok"}
    )
    if unretrieved:
        raise ValueError(
            f"Refusing to render: these cited sources did not retrieve successfully: {', '.join(unretrieved)}"
        )

    # Criterion verdicts cite sources too; evaluate_candidate already refused any
    # URL that was not retrieved, so these are safe to number alongside note URLs.
    cited_urls = {note["url"] for note in notes}
    cited_urls.update(
        verdict["url"]
        for candidate in run.candidates()
        for verdict in candidate.get("verdicts", {}).values()
        if verdict.get("url") in sources
    )
    numbering = {url: index for index, url in enumerate(sorted(cited_urls), 1)}

    lines = [f"# {title or meta['question']}", "", f"*Question:* {meta['question']}", ""]

    # Warnings first: a reader should see what is thin before reading the findings.
    open_gaps = gaps(run)
    if open_gaps:
        label = "discovery vectors" if status is not None else "sub-questions"
        lines.append(f"> **Incomplete.** These {label} are still thinly sourced:")
        lines += [f"> - {gap['sub_question']} — {'; '.join(gap['reasons'])}" for gap in open_gaps]
        lines.append("")

    if status is not None:
        lines += _render_quota_section(run, status, numbering)

    for entry in coverage(run):
        sub = entry["sub_question"]
        relevant = [note for note in notes if note.get("sub_question") == sub]
        if not relevant:
            continue
        lines += [f"## {sub}", ""]
        for stance, heading in (
            ("supports", None),
            ("contradicts", "**Sources disagree:**"),
            ("unverified", "**Could not be verified:**"),
        ):
            group = [note for note in relevant if note.get("stance") == stance]
            if not group:
                continue
            if heading:
                lines += [heading, ""]
            for note in group:
                lines.append(f"- {note['claim']} [{numbering[note['url']]}]")
            lines.append("")
        lines.append(
            f"*Sourcing: {entry['notes']} note(s) across {entry['distinct_domains']} domain(s)"
            f"{' — corroborated' if entry['corroborated'] else ' — single-source, treat as provisional'}.*"
        )
        lines.append("")

    lines += ["## Sources", ""]
    for url, index in sorted(numbering.items(), key=lambda item: item[1]):
        source = sources[url]
        label = source.get("title") or url
        lines.append(f"{index}. [{label}]({url}) — {source['domain']}, retrieved {source['retrieved_at']}")
    lines.append("")

    report = "\n".join(lines)
    run.report_path.write_text(report, encoding="utf-8")
    return report
