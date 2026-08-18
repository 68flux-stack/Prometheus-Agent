"""Self-check for the research ledger: run `python test_research.py`."""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "src"))

from research.ledger import (  # noqa: E402
    add_candidate,
    add_detail,
    add_note,
    concede,
    coverage,
    create_run,
    evaluate_candidate,
    gaps,
    may_concede,
    next_round,
    quota_status,
    register_source,
    registrable_domain,
    render_report,
    resolve_run,
    similarity,
    start_round,
)

SUBS = ["how it works", "what it costs"]
CRITERIA = ["market size", "no competitor", "willingness to pay"]
FIELDS = ["problem", "gtm"]
POLICY = ["web search", "practitioner forums", "government data"]


def _run(base: Path):
    return create_run(base, "Does it work?", SUBS, "medium")


def _quota_run(base: Path, quota: int = 2):
    run = create_run(
        base,
        "Which niches qualify?",
        ["vector a", "vector b"],
        "medium",
        quota=quota,
        criteria=CRITERIA,
        deep_dive_fields=FIELDS,
        source_policy=POLICY,
    )
    register_source(run, "https://a.example/x", "A", "ok")
    register_source(run, "https://b.example/x", "B", "ok")
    add_note(run, "vector a", "background", "https://a.example/x", "quote a", "supports")
    add_note(run, "vector b", "background", "https://b.example/x", "quote b", "supports")
    return run


def _pass_all(url: str = "https://a.example/x"):
    return {criterion: {"pass": True, "note": "ok", "url": url} for criterion in CRITERIA}


def _fail(count: int):
    verdicts = _pass_all()
    for criterion in CRITERIA[:count]:
        verdicts[criterion] = {"pass": False, "note": "does not clear the bar"}
    return verdicts


def _qualify(run, name: str, one_liner: str, vectors=("vector a",)):
    row = add_candidate(run, name, one_liner, list(vectors))
    evaluate_candidate(run, row["id"], _pass_all())
    for field in FIELDS:
        add_detail(run, row["id"], field, f"{field} for {name}")
    return row["id"]


def test_registrable_domain() -> None:
    assert registrable_domain("https://www.anthropic.com/engineering/x") == "anthropic.com"
    assert registrable_domain("https://docs.exa.ai/reference") == "exa.ai"
    assert registrable_domain("https://foo.co.uk/a") == "foo.co.uk"
    assert registrable_domain("https://a.foo.co.uk/b") == "foo.co.uk"
    # Per-author hosts must not collapse, or one blogging platform would look
    # like one source no matter how many independent authors are cited.
    assert registrable_domain("https://alice.substack.com/p/x") == "alice.substack.com"
    assert registrable_domain("https://bob.substack.com/p/y") == "bob.substack.com"
    assert registrable_domain("not a url") == ""


def test_note_requires_a_fetched_source(base: Path) -> None:
    run = _run(base)
    try:
        add_note(run, SUBS[0], "claim", "https://a.example/x", "quote", "supports")
    except ValueError as error:
        assert "has not been read" in str(error)
    else:
        raise AssertionError("note accepted a URL that was never fetched")


def test_note_dedup_and_validation(base: Path) -> None:
    run = _run(base)
    register_source(run, "https://a.example/x", "A", "ok")

    first = add_note(run, SUBS[0], "claim", "https://a.example/x", " quote ", "supports")
    assert not first.get("duplicate")
    again = add_note(run, SUBS[0], "same claim reworded", "https://a.example/x", "quote", "supports")
    assert again.get("duplicate") is True
    assert len(run.notes()) == 1

    for bad in ("maybe", ""):
        try:
            add_note(run, SUBS[0], "c", "https://a.example/x", "q2", bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"stance {bad!r} was accepted")

    try:
        add_note(run, "not a sub-question", "c", "https://a.example/x", "q3", "supports")
    except ValueError as error:
        assert "Unknown sub-question" in str(error)
    else:
        raise AssertionError("note accepted an unknown sub-question")


def test_coverage_counts_domains_not_notes(base: Path) -> None:
    run = _run(base)
    for path in ("one", "two", "three"):
        register_source(run, f"https://a.example/{path}", "A", "ok")
        add_note(run, SUBS[0], f"claim {path}", f"https://a.example/{path}", f"q {path}", "supports")

    entry = coverage(run)[0]
    assert entry["notes"] == 3, entry
    assert entry["distinct_domains"] == 1, entry
    assert entry["corroborated"] is False
    assert any(gap["sub_question"] == SUBS[0] for gap in gaps(run))

    register_source(run, "https://b.example/x", "B", "ok")
    add_note(run, SUBS[0], "claim b", "https://b.example/x", "q b", "supports")
    entry = coverage(run)[0]
    assert entry["distinct_domains"] == 2 and entry["corroborated"] is True
    assert not any(gap["sub_question"] == SUBS[0] for gap in gaps(run))


def test_conflict_needs_a_third_domain(base: Path) -> None:
    run = _run(base)
    register_source(run, "https://a.example/x", "A", "ok")
    register_source(run, "https://b.example/x", "B", "ok")
    add_note(run, SUBS[0], "it is fast", "https://a.example/x", "fast", "supports")
    add_note(run, SUBS[0], "it is slow", "https://b.example/x", "slow", "contradicts")

    reasons = [gap for gap in gaps(run) if gap["sub_question"] == SUBS[0]]
    assert reasons and any("disagree" in reason for reason in reasons[0]["reasons"]), reasons


def test_report_rejects_unretrieved_citations(base: Path) -> None:
    run = _run(base)
    register_source(run, "https://a.example/x", "A", "ok")
    add_note(run, SUBS[0], "claim", "https://a.example/x", "quote", "supports")

    # A source whose fetch failed must never end up cited.
    register_source(run, "https://dead.example/x", "Dead", "error")
    add_note(run, SUBS[1], "shaky claim", "https://dead.example/x", "quote", "supports")
    try:
        render_report(run, None)
    except ValueError as error:
        assert "did not retrieve successfully" in str(error), error
    else:
        raise AssertionError("report rendered a citation that never retrieved")


def test_report_renders_and_verifies(base: Path) -> None:
    run = _run(base)
    for host in ("a", "b"):
        register_source(run, f"https://{host}.example/x", f"Source {host.upper()}", "ok")
        for sub in SUBS:
            add_note(run, sub, f"{sub} per {host}", f"https://{host}.example/x", f"quote {host} {sub}", "supports")

    report = render_report(run, "Findings")
    assert report.startswith("# Findings")
    assert "[1]" in report and "[2]" in report
    assert "Source A" in report and "Source B" in report
    assert "Incomplete" not in report, "fully corroborated run should not warn"
    assert run.report_path.exists()


def test_start_is_idempotent(base: Path) -> None:
    first = create_run(base, "Does it work?", SUBS, "medium")
    second = create_run(base, "Does it work?", SUBS, "medium")
    assert first.dir == second.dir

    other = create_run(base, "Does it work?".upper(), SUBS, "low")
    assert other.dir != first.dir, "a different question must get its own run"

    assert resolve_run(base, str(first.dir), None).dir == first.dir
    assert resolve_run(base, None, first.dir).dir == first.dir


def test_rejects_overlapping_briefs(base: Path) -> None:
    try:
        create_run(base, "dupes", ["same", "same"], "medium")
    except ValueError as error:
        assert "unique" in str(error)
    else:
        raise AssertionError("duplicate sub-questions were accepted")


def test_evaluate_applies_the_threshold(base: Path) -> None:
    run = _quota_run(base)

    one = add_candidate(run, "Alpha", "software for widget auditors", ["vector a"])
    assert evaluate_candidate(run, one["id"], _fail(1))["status"] == "qualified", "one failure survives"

    two = add_candidate(run, "Beta", "scheduling for oyster hatcheries", ["vector b"])
    result = evaluate_candidate(run, two["id"], _fail(2))
    assert result["status"] == "rejected"
    assert result["failed_criteria"] == CRITERIA[:2]
    assert "market size" in result["rejected_reason"]

    three = add_candidate(run, "Gamma", "permits for quarry haulers", ["vector a"])
    for bad, message in (
        ({c: {"pass": True} for c in CRITERIA[:1]}, "Missing a verdict"),
        ({**_pass_all(), "invented": {"pass": True}}, "Unknown criteria"),
    ):
        try:
            evaluate_candidate(run, three["id"], bad)
        except ValueError as error:
            assert message in str(error), error
        else:
            raise AssertionError(f"accepted bad verdicts: {bad}")

    # A failing verdict without a reason, and a verdict citing an unread page.
    try:
        evaluate_candidate(run, three["id"], {**_pass_all(), CRITERIA[0]: {"pass": False, "note": ""}})
    except ValueError as error:
        assert "must carry a note" in str(error)
    else:
        raise AssertionError("accepted a failing verdict with no reason")

    try:
        evaluate_candidate(run, three["id"], _pass_all("https://never-read.example/x"))
    except ValueError as error:
        assert "never retrieved" in str(error)
    else:
        raise AssertionError("accepted a verdict citing an unfetched page")


def test_near_duplicates_are_refused_including_rejected_ones(base: Path) -> None:
    run = _quota_run(base)
    assert similarity("scheduling for oyster hatcheries", "oyster hatchery scheduling") > 0.6
    assert similarity("scheduling for oyster hatcheries", "permit filing for quarry haulers") < 0.6

    first = add_candidate(run, "Oyster hatchery scheduling", "scheduling for oyster hatcheries", ["vector a"])
    evaluate_candidate(run, first["id"], _fail(2))  # rejected, and still must block a rephrase

    try:
        add_candidate(run, "Hatchery oyster scheduler", "oyster hatcheries scheduling", ["vector b"])
    except ValueError as error:
        assert first["id"] in str(error) and "failed" in str(error), error
    else:
        raise AssertionError("a rejected idea was accepted again under a new name")

    add_candidate(run, "Quarry haul permits", "permit filing for quarry haulers", ["vector b"])


def test_report_refuses_below_quota_then_renders(base: Path) -> None:
    run = _quota_run(base, quota=2)
    first = _qualify(run, "Alpha", "software for widget auditors")

    try:
        render_report(run, None)
    except ValueError as error:
        assert "1/2 candidates qualify" in str(error) and "next_round" in str(error), error
    else:
        raise AssertionError("rendered a report below quota")

    second = _qualify(run, "Beta", "permit filing for quarry haulers", ["vector b"])
    report = render_report(run, "Findings")
    assert "Qualified candidates (2/2)" in report
    assert "Alpha" in report and "Beta" in report
    assert first != second


def test_report_refuses_incomplete_deep_dives(base: Path) -> None:
    run = _quota_run(base, quota=1)
    row = add_candidate(run, "Alpha", "software for widget auditors", ["vector a"])
    evaluate_candidate(run, row["id"], _pass_all())
    add_detail(run, row["id"], "problem", "auditors retype everything")

    try:
        render_report(run, None)
    except ValueError as error:
        assert "incomplete deep dives" in str(error) and "gtm" in str(error), error
    else:
        raise AssertionError("rendered a candidate missing a required field")

    add_detail(run, row["id"], "gtm", "trade associations")
    assert "Qualified candidates (1/1)" in render_report(run, None)


def test_next_round_rotates_source_classes(base: Path) -> None:
    run = _quota_run(base, quota=5)
    rejected = add_candidate(run, "Alpha", "software for widget auditors", ["vector a"])
    evaluate_candidate(run, rejected["id"], _fail(2))

    second = next_round(run)
    assert second["round"] == 2
    assert second["shortfall"] == 5
    # Round 1 consumed the first policy entry, so round 2 must move on.
    assert POLICY[0] in second["already_used_source_classes"]
    assert POLICY[0] not in second["mandated_source_classes"]
    assert [r["name"] for r in second["rejections"]] == ["Alpha"]
    assert second["rejections_by_criterion"], "rejection tallies should steer the next round"
    assert "vector b" in second["untried_vectors"]

    next_round(run)
    try:
        next_round(run)
    except ValueError as error:
        assert "source_policy has been used" in str(error), error
    else:
        raise AssertionError("kept opening rounds after every source class was exhausted")


def test_concede_requires_two_stalled_rounds(base: Path) -> None:
    run = _quota_run(base, quota=3)
    _qualify(run, "Alpha", "software for widget auditors")
    rejected = add_candidate(run, "Beta", "permit filing for quarry haulers", ["vector b"])
    evaluate_candidate(run, rejected["id"], _fail(2))

    try:
        concede(run, "market is thin")
    except ValueError as error:
        assert "1 round(s) have run" in str(error), error
    else:
        raise AssertionError("conceded straight out of round one")

    start_round(run, ["practitioner forums"])
    assert not may_concede(run)[0], "two rounds is not yet a stalled search"

    start_round(run, ["government data"])
    result = concede(run, "only one niche clears the TAM bar")
    assert result["qualified"] == 1

    report = render_report(run, None)
    assert "Short of quota: 1 of 3" in report
    assert "only one niche clears the TAM bar" in report
    assert "Rejected (1)" in report and "Beta" in report
    assert "Search rounds" in report

    # A round that does yield resets the stall, so the run cannot coast to a concession.
    _qualify(run, "Gamma", "inventory counts for hop farms", ["vector b"])
    allowed, why = may_concede(run)
    assert not allowed and "consecutive round" in why, why


def test_quota_status_tallies_rejections(base: Path) -> None:
    run = _quota_run(base, quota=4)
    for name, one_liner in (
        ("Alpha", "scheduling for oyster hatcheries"),
        ("Beta", "permit filing for quarry haulers"),
    ):
        row = add_candidate(run, name, one_liner, ["vector a"])
        evaluate_candidate(run, row["id"], _fail(2))

    status = quota_status(run)
    assert status["qualified"] == 0 and status["rejected"] == 2 and status["shortfall"] == 4
    assert status["rejections_by_criterion"][CRITERIA[0]] == 2
    assert status["rounds"][0]["registered"] == 2


def test_non_quota_runs_are_unaffected(base: Path) -> None:
    run = _run(base)
    register_source(run, "https://a.example/x", "A", "ok")
    register_source(run, "https://b.example/x", "B", "ok")
    for host in ("a", "b"):
        for sub in SUBS:
            add_note(run, sub, f"{sub} per {host}", f"https://{host}.example/x", f"q {host} {sub}", "supports")

    report = render_report(run, None)
    assert "Qualified candidates" not in report
    try:
        next_round(run)
    except ValueError as error:
        assert "only applies to a quota run" in str(error)
    else:
        raise AssertionError("next_round ran on a run with no quota")


def main() -> None:
    test_registrable_domain()
    for test in (
        test_note_requires_a_fetched_source,
        test_note_dedup_and_validation,
        test_coverage_counts_domains_not_notes,
        test_conflict_needs_a_third_domain,
        test_report_rejects_unretrieved_citations,
        test_report_renders_and_verifies,
        test_start_is_idempotent,
        test_rejects_overlapping_briefs,
        test_evaluate_applies_the_threshold,
        test_near_duplicates_are_refused_including_rejected_ones,
        test_report_refuses_below_quota_then_renders,
        test_report_refuses_incomplete_deep_dives,
        test_next_round_rotates_source_classes,
        test_concede_requires_two_stalled_rounds,
        test_quota_status_tallies_rejections,
        test_non_quota_runs_are_unaffected,
    ):
        with tempfile.TemporaryDirectory() as tmp:
            test(Path(tmp) / "research")
    print("ok")


if __name__ == "__main__":
    main()
