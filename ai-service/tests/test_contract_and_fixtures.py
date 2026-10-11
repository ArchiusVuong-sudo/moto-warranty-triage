from __future__ import annotations

import copy
import json

import pytest

from triage_service.config import FIXTURES_DIR
from triage_service.contract import contract_errors, load_schema
from triage_service.evals import run_eval
from triage_service.guardrails import enforce_rules
from triage_service.models import ride_log_sha256
from triage_service.replay import fixture_index, load_fixture
from triage_service.scenarios import all_scenarios
from triage_service.tools import TOOLS, run_tool

FIXTURES = sorted(FIXTURES_DIR.glob("*.json"))
FIXTURES = [p for p in FIXTURES if p.name != "eval-report.json"]


def test_every_valid_scenario_has_a_fixture():
    have = {load_fixture(p).scenario for p in FIXTURES}
    want = {d["id"] for d in all_scenarios() if d["expected"]["decision"] != "dead_letter"}
    assert have == want


@pytest.mark.parametrize("path", FIXTURES, ids=lambda p: p.stem)
def test_fixture_is_a_labelled_live_recording(path):
    fx = load_fixture(path)
    assert fx.source["kind"] == "live"
    assert fx.source["model"].startswith("claude-")
    assert len(fx.source["recorded_at"]) == 10
    assert fx.run["duration_ms"] > 0 and fx.run["cost_usd"] > 0
    assert contract_errors(fx.result) == []


@pytest.mark.parametrize("path", FIXTURES, ids=lambda p: p.stem)
def test_fixture_matches_its_ride_log_and_tools_have_not_drifted(path, make_ctx):
    fx = load_fixture(path)
    doc = next(d for d in all_scenarios() if d["id"] == fx.scenario)
    assert ride_log_sha256(doc["ride_log"]) == fx.ride_log_sha256
    ctx = make_ctx(fx.scenario)
    specs = {t.name: t for t in TOOLS}
    for span in fx.spans:
        if span["name"] == "check_warranty":
            continue  # depends on the vehicle's age at filing time
        ok, out = run_tool(ctx, specs[span["name"]], span["input"])
        assert ok == span["ok"]
        assert json.loads(json.dumps(out)) == span["output"], f"{span['name']} output changed since the fixture was recorded"


def test_contract_rejects_bad_results():
    good = load_fixture(FIXTURES[0]).result
    cases = []
    for mutate in (
        lambda r: r.pop("warranty"),
        lambda r: r["root_cause"].update(confidence=1.5),
        lambda r: r["root_cause"].update(code="GREMLINS"),
        lambda r: r["warranty"].update(clause="W9"),
        lambda r: r["repair"]["parts"].append({"part_number": "bad", "description": "x y", "qty": 1}),
        lambda r: r.update(extra_field=True),
        lambda r: r.update(evidence=[]),
    ):
        bad = copy.deepcopy(good)
        mutate(bad)
        cases.append(contract_errors(bad))
    assert all(cases), "every mutation must break the contract"
    assert load_schema()["properties"]["schema_version"]["enum"] == ["1"]


def test_guardrail_overrides_a_wrong_warranty(make_ctx):
    fx = next(load_fixture(p) for p in FIXTURES if load_fixture(p).scenario == "impact-before-fault")
    wrong = copy.deepcopy(fx.result)
    wrong["warranty"] = {"decision": "covered", "clause": "W1", "reason": "Looks like a defect."}
    fixed, notes = enforce_rules(wrong, make_ctx("impact-before-fault"), called_tools=set())
    assert fixed["warranty"]["decision"] == "not_covered" and fixed["warranty"]["clause"] == "W6"
    assert any("set by rules" in n for n in notes) and any("skipped check_warranty" in n for n in notes)


async def test_replay_eval_scores_every_case():
    fixture_index.cache_clear()
    report = await run_eval(live=False)
    assert report["totals"]["root_cause"] == "7/7"
    assert report["totals"]["warranty"] == "7/7"
    assert report["totals"]["evidence"] == "7/7"
