"""The four read-only triage tools.

Each tool is a plain function over a `TriageContext` with a pydantic input
model, so it is unit-tested without the SDK. `build_sdk_tools` wraps them for
the in-process MCP server: it validates input, times the call and emits one
span per call to the caller's sink.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .knowledge import Knowledge, parse_version
from .models import REQUIRED_COLUMNS, Telemetry, TriageRequest, VehicleFacts
from .rules import CAUSE_CODES, decide

SIGNALS = tuple(c for c in REQUIRED_COLUMNS if c != "t") + ("cell_delta_mv",)


@dataclass
class TriageContext:
    request: TriageRequest
    telemetry: Telemetry
    facts: VehicleFacts
    kb: Knowledge
    warranty_checks: list[dict[str, Any]] = field(default_factory=list)


# ---------- analyze_telemetry ----------


class AnalyzeTelemetryInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    signals: list[Literal[SIGNALS]] | None = Field(default=None, max_length=len(SIGNALS))  # type: ignore[valid-type]
    start_s: int | None = Field(default=None, ge=0)
    end_s: int | None = Field(default=None, ge=0)


def _windows(ts: list[float], mask: list[bool]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    start: int | None = None
    for i, m in enumerate(mask):
        if m and start is None:
            start = i
        if not m and start is not None:
            out.append((start, i - 1))
            start = None
    if start is not None:
        out.append((start, len(mask) - 1))
    return out


def _event(kind: str, ts: list[float], a: int, b: int, **extra: Any) -> dict[str, Any]:
    return {"kind": kind, "window": f"t={int(ts[a])}-{int(ts[b])}s", **{k: round(v, 2) if isinstance(v, float) else v for k, v in extra.items()}}


def detect_events(tel: Telemetry, lo: int = 0, hi: int | None = None) -> list[dict[str, Any]]:
    s = tel.series
    ts = s["t"]
    n = len(ts)
    hi = n - 1 if hi is None else min(hi, n - 1)
    idx = range(lo, hi + 1)
    events: list[dict[str, Any]] = []

    def add(kind: str, mask: list[bool], extra: Callable[[int, int], dict[str, Any]], cap: int = 8) -> None:
        wins = _windows(ts, [mask[i] if lo <= i <= hi else False for i in range(n)])
        for a, b in wins[:cap]:
            events.append(_event(kind, ts, a, b, **extra(a, b)))
        if len(wins) > cap:
            events.append({"kind": kind, "window": "more", "count": len(wins)})

    delta = [(s["cell_max_v"][i] - s["cell_min_v"][i]) * 1000 for i in range(n)]
    add(
        "cell_delta_over_150mv",
        [d > 150 for d in delta],
        lambda a, b: {"max_delta_mv": max(delta[a : b + 1]), "max_current_a": max(s["current_a"][a : b + 1]), "min_cell_v": min(s["cell_min_v"][a : b + 1])},
    )
    add("current_over_450a", [c > 450 for c in s["current_a"]], lambda a, b: {"peak_a": max(s["current_a"][a : b + 1]), "inverter_temp_c": s["inverter_temp_c"][a]})
    add(
        "coolant_flow_below_1lpm_while_riding",
        [s["coolant_flow_lpm"][i] < 1.0 and s["speed_kmh"][i] > 5 for i in range(n)],
        lambda a, b: {"min_flow_lpm": min(s["coolant_flow_lpm"][a : b + 1]), "motor_temp_start_c": s["motor_temp_c"][a], "motor_temp_end_c": s["motor_temp_c"][b]},
        cap=3,
    )
    add("motor_over_140c", [m > 140 for m in s["motor_temp_c"]], lambda a, b: {"peak_c": max(s["motor_temp_c"][a : b + 1])}, cap=3)
    add(
        "throttle_dropout_at_speed",
        [i > 0 and s["throttle_pct"][i] == 0 and s["throttle_pct"][i - 1] > 25 and s["speed_kmh"][i] > 15 for i in range(n)],
        lambda a, b: {"imu_peak_g": s["imu_peak_g"][a], "speed_kmh": s["speed_kmh"][a]},
    )
    add("impact_over_6g", [g > 6 for g in s["imu_peak_g"]], lambda a, b: {"peak_g": max(s["imu_peak_g"][a : b + 1]), "speed_kmh": s["speed_kmh"][a]})
    add("humidity_over_95pct", [h >= 95 for h in s["humidity_pct"]], lambda a, b: {"peak_pct": max(s["humidity_pct"][a : b + 1])}, cap=2)
    charging = [p > 1 for p in s["charge_power_kw"]]
    stops = [i > 0 and charging[i - 1] and not charging[i] for i in range(n)]
    add("charging_stopped", stops, lambda a, b: {"soc_pct": s["soc_pct"][a], "power_before_kw": s["charge_power_kw"][a - 1]}, cap=3)
    return events


def analyze_telemetry(ctx: TriageContext, args: AnalyzeTelemetryInput) -> dict[str, Any]:
    tel = ctx.telemetry
    ts = tel.series["t"]
    lo = 0
    hi = len(ts) - 1
    if args.start_s is not None:
        lo = next((i for i, t in enumerate(ts) if t >= args.start_s), hi)
    if args.end_s is not None:
        hi = max(lo, max((i for i, t in enumerate(ts) if t <= args.end_s), default=lo))
    names = list(args.signals) if args.signals else list(SIGNALS)
    stats: dict[str, dict[str, float]] = {}
    for name in names:
        if name == "cell_delta_mv":
            vals = [(tel.series["cell_max_v"][i] - tel.series["cell_min_v"][i]) * 1000 for i in range(lo, hi + 1)]
        else:
            vals = tel.series[name][lo : hi + 1]
        stats[name] = {"min": round(min(vals), 3), "max": round(max(vals), 3), "mean": round(sum(vals) / len(vals), 3)}
    return {
        "window": f"t={int(ts[lo])}-{int(ts[hi])}s",
        "samples": hi - lo + 1,
        "firmware": tel.firmware,
        "fault_codes": [{"t": f.t, "code": f.code} for f in tel.faults if lo <= f.t <= int(ts[hi]) + 2][:40],
        "stats": stats,
        "events": detect_events(tel, lo, hi),
    }


# ---------- lookup_fault_code ----------


class LookupFaultCodeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(pattern=r"^[A-Z]{2,4}-[0-9]{3}$")


def lookup_fault_code(ctx: TriageContext, args: LookupFaultCodeInput) -> dict[str, Any]:
    entry = ctx.kb.fault_codes.get(args.code)
    seen = [f.t for f in ctx.telemetry.faults if f.code == args.code]
    if entry is None:
        return {"code": args.code, "found": False, "logged_at_s": seen}
    return {"found": True, **entry, "logged_at_s": seen}


# ---------- search_service_bulletins ----------


class SearchBulletinsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(min_length=2, max_length=200)
    model: str | None = Field(default=None, max_length=40)


def search_service_bulletins(ctx: TriageContext, args: SearchBulletinsInput) -> dict[str, Any]:
    model = args.model or ctx.request.vehicle.model
    hits = ctx.kb.search_bulletins(args.query, model)
    fw = parse_version(ctx.telemetry.firmware)
    out = []
    for b in hits:
        item = {k: b[k] for k in ("id", "title", "symptoms", "fix", "parts", "labour_hours", "min_firmware")}
        if b.get("min_firmware"):
            item["vehicle_firmware_below_minimum"] = fw < parse_version(b["min_firmware"])
        out.append(item)
    return {"model": model, "results": out}


# ---------- check_warranty ----------


class CheckWarrantyInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    cause_code: Literal[CAUSE_CODES]  # type: ignore[valid-type]
    confidence: float = Field(ge=0, le=1)


def check_warranty(ctx: TriageContext, args: CheckWarrantyInput) -> dict[str, Any]:
    d = decide(args.cause_code, args.confidence, ctx.facts, ctx.kb)
    out = {**d.as_dict(), "clause_text": ctx.kb.clauses[d.clause]["text"], "facts": ctx.facts.as_dict()}
    ctx.warranty_checks.append({"cause_code": args.cause_code, **d.as_dict()})
    return out


# ---------- registry and SDK wrapping ----------


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_model: type[BaseModel]
    fn: Callable[[TriageContext, Any], dict[str, Any]]


TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec(
        "analyze_telemetry",
        "Stats and detected events for the claim's ride log (1 Hz). Optional signal list and time window in seconds.",
        AnalyzeTelemetryInput,
        analyze_telemetry,
    ),
    ToolSpec("lookup_fault_code", "Meaning, likely causes and checks for one fault code, plus when it was logged on this ride.", LookupFaultCodeInput, lookup_fault_code),
    ToolSpec(
        "search_service_bulletins",
        "Keyword search over service bulletins for this bike model. Returns fixes, parts, labour and firmware minimums.",
        SearchBulletinsInput,
        search_service_bulletins,
    ),
    ToolSpec(
        "check_warranty",
        "Rules-based warranty decision for a proposed root cause. The rules use vehicle age, odometer, impact and water facts from the ride log.",
        CheckWarrantyInput,
        check_warranty,
    ),
)

SERVER_NAME = "triage"
ALLOWED_TOOL_NAMES = tuple(f"mcp__{SERVER_NAME}__{t.name}" for t in TOOLS)

SpanSink = Callable[[dict[str, Any]], Awaitable[None]]


def run_tool(ctx: TriageContext, spec: ToolSpec, raw: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    """Validate and run one tool. Returns (ok, payload); invalid input is an error payload, not an exception."""
    try:
        args = spec.input_model.model_validate(raw)
    except ValidationError as e:
        return False, {"error": "invalid input", "details": [f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in e.errors()][:5]}
    return True, spec.fn(ctx, args)


def build_sdk_tools(ctx: TriageContext, sink: SpanSink) -> list[Any]:
    from claude_agent_sdk import tool

    def wrap(spec: ToolSpec) -> Any:
        schema = spec.input_model.model_json_schema()

        @tool(spec.name, spec.description, schema)
        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            started = datetime.now(timezone.utc)
            t0 = time.perf_counter()
            ok, payload = run_tool(ctx, spec, args)
            await sink(
                {
                    "name": spec.name,
                    "input": args,
                    "output": payload,
                    "ok": ok,
                    "started_at": started.isoformat(),
                    "duration_ms": round((time.perf_counter() - t0) * 1000, 2),
                }
            )
            result: dict[str, Any] = {"content": [{"type": "text", "text": json.dumps(payload)}]}
            if not ok:
                result["is_error"] = True
            return result

        return handler

    return [wrap(t) for t in TOOLS]
