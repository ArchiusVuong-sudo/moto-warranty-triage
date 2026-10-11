from __future__ import annotations

from dataclasses import replace

import pytest

from triage_service.rules import decide


def facts_of(make_ctx, sid, **kw):
    return replace(make_ctx(sid).facts, **kw)


def test_battery_inside_w2(make_ctx, kb):
    d = decide("BATTERY_CELL_IMBALANCE", 0.9, facts_of(make_ctx, "cell-imbalance"), kb)
    assert (d.decision, d.clause) == ("covered", "W2")


def test_battery_over_w2_mileage(make_ctx, kb):
    d = decide("BATTERY_CELL_IMBALANCE", 0.9, facts_of(make_ctx, "cell-imbalance", odometer_km=31000), kb)
    assert (d.decision, d.clause) == ("not_covered", "W2")
    assert "30000 km" in d.reason


def test_battery_w2_runs_36_months_but_drive_unit_only_24(make_ctx, kb):
    f = facts_of(make_ctx, "inverter-overcurrent", age_months=30)
    assert decide("BATTERY_CELL_IMBALANCE", 0.9, f, kb).decision == "covered"
    assert (decide("INVERTER_OVERCURRENT", 0.9, f, kb).decision, decide("INVERTER_OVERCURRENT", 0.9, f, kb).clause) == ("not_covered", "W3")


def test_cooling_w4_and_throttle_w1(make_ctx, kb):
    assert decide("COOLANT_PUMP_FAILURE", 0.8, facts_of(make_ctx, "coolant-pump"), kb).clause == "W4"
    assert decide("THROTTLE_CONNECTOR_INTERMITTENT", 0.8, facts_of(make_ctx, "throttle-connector"), kb).clause == "W1"


def test_firmware_below_bulletin_minimum_is_covered_w5(make_ctx, kb):
    d = decide("FIRMWARE_BELOW_MINIMUM", 0.9, facts_of(make_ctx, "firmware-charge-stop"), kb)
    assert (d.decision, d.clause) == ("covered", "W5")
    assert "SB-2026-06" in d.reason


def test_firmware_claim_on_current_firmware_needs_inspection(make_ctx, kb):
    d = decide("FIRMWARE_BELOW_MINIMUM", 0.9, facts_of(make_ctx, "firmware-charge-stop", firmware="4.2.0"), kb)
    assert d.decision == "needs_inspection"


def test_impact_excludes_any_cause_w6(make_ctx, kb):
    f = facts_of(make_ctx, "impact-before-fault")
    for cause in ("IMPACT_DAMAGE", "BATTERY_CELL_IMBALANCE", "THROTTLE_CONNECTOR_INTERMITTENT"):
        d = decide(cause, 0.9, f, kb)
        assert (d.decision, d.clause) == ("not_covered", "W6")


def test_water_from_washing_excluded_w7(make_ctx, kb):
    d = decide("CHARGE_PORT_WATER_INGRESS", 0.9, facts_of(make_ctx, "water-ingress"), kb)
    assert (d.decision, d.clause) == ("not_covered", "W7")
    dry = decide("CHARGE_PORT_WATER_INGRESS", 0.9, facts_of(make_ctx, "water-ingress", water_exposure=False), kb)
    assert dry.decision == "covered"


def test_low_confidence_or_undetermined_needs_inspection(make_ctx, kb):
    f = facts_of(make_ctx, "cell-imbalance")
    assert decide("BATTERY_CELL_IMBALANCE", 0.3, f, kb).decision == "needs_inspection"
    assert decide("UNDETERMINED", 0.9, f, kb).decision == "needs_inspection"


def test_unknown_cause_is_an_error(make_ctx, kb):
    with pytest.raises(ValueError):
        decide("FLUX_CAPACITOR", 0.9, facts_of(make_ctx, "cell-imbalance"), kb)
