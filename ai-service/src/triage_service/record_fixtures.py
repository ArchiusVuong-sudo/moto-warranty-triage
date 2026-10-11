"""Record replay fixtures from real live runs.

    uv run python -m triage_service.record_fixtures [scenario-id ...]

Each valid scenario runs once on the live model through the same pipeline the
service uses. The raw model output, the tool spans and the run's cost and
latency go to fixtures/<scenario>.json with a source block naming the date and
model. Keys are sorted so a diff shows only what really changed.
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

from .config import FIXTURES_DIR, Settings
from .env import scrub_process_env
from .knowledge import load_knowledge
from .models import parse_ride_log, ride_log_sha256, vehicle_facts
from .pipeline import triage_once
from .scenarios import all_scenarios, scenario_request
from .tools import TriageContext


async def record(doc: dict[str, Any], settings: Settings) -> dict[str, Any]:
    req = scenario_request(doc)
    tel = parse_ride_log(req.ride_log)
    ctx = TriageContext(request=req, telemetry=tel, facts=vehicle_facts(req, tel), kb=load_knowledge())
    spans: list[dict[str, Any]] = []

    async def sink(span: dict[str, Any]) -> None:
        spans.append({**span, "seq": len(spans) + 1})
        print(f"  span {span['name']} ok={span['ok']}", file=sys.stderr, flush=True)

    out = await triage_once(ctx, settings, sink)
    run = {k: out.run[k] for k in ("model", "duration_ms", "cost_usd", "num_turns", "input_tokens", "output_tokens")}
    return {
        "_note": "Recorded from a live run on synthetic data. Replay mode streams these spans and this model output.",
        "scenario": doc["id"],
        "ride_log_sha256": ride_log_sha256(doc["ride_log"]),
        "source": {"kind": "live", "recorded_at": datetime.now(UTC).date().isoformat(), "model": settings.model},
        "spans": spans,
        "result": out.model_output,
        "run": run,
    }


async def main(ids: list[str]) -> int:
    scrub_process_env()
    settings = replace(Settings.from_env(), mode="live")
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    docs = [d for d in all_scenarios() if d["expected"]["decision"] != "dead_letter" and (not ids or d["id"] in ids)]
    failed = 0
    for doc in docs:
        print(f"recording {doc['id']} on {settings.model}", file=sys.stderr, flush=True)
        try:
            fx = await record(doc, settings)
        except Exception as e:  # noqa: BLE001 - keep recording the others
            print(f"  FAILED {type(e).__name__}: {e}", file=sys.stderr)
            failed += 1
            continue
        path: Path = FIXTURES_DIR / f"{doc['id']}.json"
        path.write_text(json.dumps(fx, indent=2, sort_keys=True) + "\n")
        print(f"  wrote {path.name}: {fx['result']['root_cause']['code']} in {fx['run']['duration_ms']} ms, ${fx['run']['cost_usd']}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ids", nargs="*")
    sys.exit(asyncio.run(main(parser.parse_args().ids)))
