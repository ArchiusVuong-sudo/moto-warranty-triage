"""Score the triage agent on the labelled scenarios.

    uv run python -m triage_service.evals            # replay fixtures, no model call
    uv run python -m triage_service.evals --live     # fresh live runs
    uv run python -m triage_service.evals --out fixtures/eval-report.json

Checks per scenario: root cause code, warranty decision and clause (after the
rules guardrail), evidence that cites telemetry and a fault code, and whether
the model's own warranty answer already matched the rules.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .config import Settings
from .env import scrub_process_env
from .knowledge import load_knowledge
from .models import parse_ride_log, ride_log_sha256, vehicle_facts
from .pipeline import triage_once
from .replay import fixture_index
from .scenarios import all_scenarios, scenario_request
from .tools import TriageContext

CHECKS = ("root_cause", "warranty", "evidence", "model_matched_rules")


def score_case(expected: dict[str, str], result: dict[str, Any], model_output: dict[str, Any]) -> dict[str, bool]:
    kinds = {e["kind"] for e in result["evidence"]}
    return {
        "root_cause": result["root_cause"]["code"] == expected["cause"],
        "warranty": (result["warranty"]["decision"], result["warranty"]["clause"]) == (expected["decision"], expected["clause"]),
        "evidence": {"telemetry", "fault_code"} <= kinds,
        "model_matched_rules": (model_output["warranty"]["decision"], model_output["warranty"]["clause"])
        == (result["warranty"]["decision"], result["warranty"]["clause"]),
    }


async def run_eval(live: bool) -> dict[str, Any]:
    settings = replace(Settings.from_env(), mode="live" if live else "replay", span_delay_ms=0)
    fixtures = fixture_index()
    kb = load_knowledge()
    cases: list[dict[str, Any]] = []
    for doc in all_scenarios():
        if doc["expected"]["decision"] == "dead_letter":
            continue
        req = scenario_request(doc)
        tel = parse_ride_log(req.ride_log)
        ctx = TriageContext(request=req, telemetry=tel, facts=vehicle_facts(req, tel), kb=kb)

        async def sink(_: dict[str, Any]) -> None:
            return None

        fixture = None if live else fixtures.get(ride_log_sha256(doc["ride_log"]))
        if not live and fixture is None:
            cases.append({"scenario": doc["id"], "error": "no fixture"})
            continue
        out = await triage_once(ctx, settings, sink, fixture=fixture)
        checks = score_case(doc["expected"], out.result, out.model_output)
        cases.append(
            {
                "scenario": doc["id"],
                "expected": doc["expected"]["cause"],
                "got": out.result["root_cause"]["code"],
                "confidence": out.result["root_cause"]["confidence"],
                "checks": checks,
                "duration_ms": out.run.get("duration_ms"),
                "cost_usd": out.run.get("cost_usd"),
                "source": out.run.get("source"),
            }
        )
    scored = [c for c in cases if "checks" in c]
    totals = {k: sum(1 for c in scored if c["checks"][k]) for k in CHECKS}
    return {
        "mode": "live" if live else "replay",
        "model": settings.model if live else sorted({c["source"]["model"] for c in scored if c.get("source")}),
        "run_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "cases": cases,
        "totals": {k: f"{v}/{len(scored)}" for k, v in totals.items()},
        "mean_duration_ms": round(sum(c["duration_ms"] or 0 for c in scored) / max(1, len(scored))),
        "total_cost_usd": round(sum(c["cost_usd"] or 0 for c in scored), 4),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    scrub_process_env()
    report = asyncio.run(run_eval(args.live))
    for c in report["cases"]:
        marks = " ".join(f"{k}={'ok' if v else 'MISS'}" for k, v in c.get("checks", {}).items()) or c.get("error", "")
        print(f"{c['scenario']:<22} {marks}")
    print("totals:", report["totals"], "mean latency", report["mean_duration_ms"], "ms, cost $", report["total_cost_usd"])
    if args.out:
        args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return 0 if all(c.get("checks", {}).get("root_cause") for c in report["cases"]) else 1


if __name__ == "__main__":
    sys.exit(main())
