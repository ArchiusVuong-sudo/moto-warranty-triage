"""One triage: live model run or replay, then the contract check and the rules guardrail."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from .agent import run_live
from .config import Settings
from .contract import load_schema, validate_result
from .guardrails import enforce_rules
from .replay import Fixture, replay
from .tools import SpanSink, TriageContext


@dataclass(frozen=True)
class Outcome:
    result: dict[str, Any]
    run: dict[str, Any]
    model_output: dict[str, Any]
    live_model_runs: int


async def triage_once(
    ctx: TriageContext,
    settings: Settings,
    sink: SpanSink,
    fixture: Fixture | None = None,
    on_retry: Callable[[str], Awaitable[None]] | None = None,
) -> Outcome:
    if settings.mode == "live":
        live = await run_live(ctx, settings, sink, load_schema(), on_retry=on_retry)
        raw, meta, runs = live.result, live.meta, live.model_runs
        meta = {**meta, "mode": "live", "source": {"kind": "live", "model": settings.model}, "model_retries": live.retries}
    else:
        if fixture is None:
            raise LookupError("replay mode needs a fixture")
        raw, meta = await replay(fixture, sink, settings.span_delay_ms)
        runs = 0
        meta = {**meta, "mode": "replay", "source": fixture.source}
    validate_result(raw)
    result, guardrails = enforce_rules(raw, ctx)
    validate_result(result)
    run = {**meta, "model_runs": max(runs, 1), "served_from_store": False, "guardrails": guardrails}
    return Outcome(result=result, run=run, model_output=raw, live_model_runs=runs)
