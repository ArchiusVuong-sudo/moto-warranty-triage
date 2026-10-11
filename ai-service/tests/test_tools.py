from __future__ import annotations

import json

import pytest

from triage_service.tools import (
    ALLOWED_TOOL_NAMES,
    TOOLS,
    AnalyzeTelemetryInput,
    CheckWarrantyInput,
    LookupFaultCodeInput,
    SearchBulletinsInput,
    analyze_telemetry,
    build_sdk_tools,
    check_warranty,
    lookup_fault_code,
    run_tool,
    search_service_bulletins,
)

EXPECTED_EVENT = {
    "cell-imbalance": "cell_delta_over_150mv",
    "inverter-overcurrent": "current_over_450a",
    "coolant-pump": "coolant_flow_below_1lpm_while_riding",
    "throttle-connector": "throttle_dropout_at_speed",
    "impact-before-fault": "impact_over_6g",
    "water-ingress": "humidity_over_95pct",
    "firmware-charge-stop": "charging_stopped",
}


@pytest.mark.parametrize("sid,kind", EXPECTED_EVENT.items())
def test_each_scenario_shows_its_signature_event(make_ctx, sid, kind):
    out = analyze_telemetry(make_ctx(sid), AnalyzeTelemetryInput())
    assert kind in {e["kind"] for e in out["events"]}
    assert out["samples"] == 600


def test_healthy_signals_do_not_raise_unrelated_events(make_ctx):
    kinds = {e["kind"] for e in analyze_telemetry(make_ctx("inverter-overcurrent"), AnalyzeTelemetryInput())["events"]}
    assert "cell_delta_over_150mv" not in kinds and "impact_over_6g" not in kinds and "coolant_flow_below_1lpm_while_riding" not in kinds


def test_window_and_signal_selection(make_ctx):
    out = analyze_telemetry(make_ctx("impact-before-fault"), AnalyzeTelemetryInput(signals=["imu_peak_g", "speed_kmh"], start_s=300, end_s=330))
    assert out["window"] == "t=300-330s"
    assert set(out["stats"]) == {"imu_peak_g", "speed_kmh"}
    assert out["stats"]["imu_peak_g"]["max"] == pytest.approx(9.4)
    assert [e["kind"] for e in out["events"]] == ["impact_over_6g"]


def test_derived_cell_delta_signal(make_ctx):
    out = analyze_telemetry(make_ctx("cell-imbalance"), AnalyzeTelemetryInput(signals=["cell_delta_mv"]))
    assert out["stats"]["cell_delta_mv"]["max"] > 150


def test_lookup_fault_code(make_ctx):
    ctx = make_ctx("cell-imbalance")
    hit = lookup_fault_code(ctx, LookupFaultCodeInput(code="BMS-201"))
    assert hit["found"] and hit["title"] == "Cell voltage deviation high" and hit["logged_at_s"]
    miss = lookup_fault_code(ctx, LookupFaultCodeInput(code="ZZZ-999"))
    assert miss == {"code": "ZZZ-999", "found": False, "logged_at_s": []}


def test_bulletin_search_ranks_the_matching_bulletin_first(make_ctx):
    out = search_service_bulletins(make_ctx("cell-imbalance"), SearchBulletinsInput(query="power cut under acceleration BMS-201"))
    assert out["results"][0]["id"] == "SB-2026-01"
    assert out["model"] == "Ridgeback MX"


def test_bulletin_search_flags_old_firmware(make_ctx):
    out = search_service_bulletins(make_ctx("firmware-charge-stop"), SearchBulletinsInput(query="charging stops at 80% BMS-210"))
    top = out["results"][0]
    assert top["id"] == "SB-2026-06" and top["vehicle_firmware_below_minimum"] is True


def test_bulletin_search_respects_model(make_ctx):
    out = search_service_bulletins(make_ctx("cell-imbalance"), SearchBulletinsInput(query="display blank DSP-901"))
    assert all(r["id"] != "SB-2026-07" for r in out["results"])  # supermoto-only bulletin


def test_check_warranty_returns_clause_text_and_facts(make_ctx):
    out = check_warranty(make_ctx("water-ingress"), CheckWarrantyInput(cause_code="CHARGE_PORT_WATER_INGRESS", confidence=0.8))
    assert out["decision"] == "not_covered" and out["clause"] == "W7"
    assert "pressure washing" in out["clause_text"]
    assert out["facts"]["water_exposure"] is True


@pytest.mark.parametrize(
    "name,args",
    [
        ("lookup_fault_code", {"code": "bms201"}),
        ("analyze_telemetry", {"signals": ["not_a_signal"]}),
        ("check_warranty", {"cause_code": "GREMLINS", "confidence": 0.5}),
        ("check_warranty", {"cause_code": "IMPACT_DAMAGE", "confidence": 3}),
        ("search_service_bulletins", {"query": "x" * 500}),
        ("search_service_bulletins", {"query": "ok", "extra": 1}),
    ],
)
def test_invalid_tool_input_is_an_error_payload(make_ctx, name, args):
    spec = next(t for t in TOOLS if t.name == name)
    ok, payload = run_tool(make_ctx("cell-imbalance"), spec, args)
    assert ok is False and payload["error"] == "invalid input" and payload["details"]


async def test_sdk_wrappers_emit_one_span_per_call(make_ctx):
    spans = []

    async def sink(s):
        spans.append(s)

    tools = build_sdk_tools(make_ctx("cell-imbalance"), sink)
    assert [t.name for t in tools] == [n.split("__")[-1] for n in ALLOWED_TOOL_NAMES]
    lookup = next(t for t in tools if t.name == "lookup_fault_code")
    good = await lookup.handler({"code": "BMS-201"})
    bad = await lookup.handler({"code": "nope"})
    assert json.loads(good["content"][0]["text"])["found"] is True
    assert bad["is_error"] is True
    assert [s["ok"] for s in spans] == [True, False]
    assert spans[0]["name"] == "lookup_fault_code" and spans[0]["duration_ms"] >= 0
