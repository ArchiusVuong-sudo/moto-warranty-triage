from __future__ import annotations

from datetime import date

import pytest

from triage_service.models import RideLogError, months_between, parse_ride_log, ride_log_sha256, vehicle_facts


def test_valid_log_parses(make_request):
    tel = parse_ride_log(make_request("coolant-pump").ride_log)
    assert tel.seconds == 600
    assert tel.firmware == "4.1.2"
    assert {f.code for f in tel.faults} == {"COOL-501", "MOT-401", "VCU-120"}


def test_corrupt_export_lists_each_problem(make_request):
    with pytest.raises(RideLogError) as e:
        parse_ride_log(make_request("corrupt-export").ride_log)
    text = " | ".join(e.value.errors)
    assert "row 200: 9 values, expected 16" in text
    assert "time goes backwards" in text
    assert "not a finite number" in text


def test_missing_column_is_rejected(make_request):
    req = make_request("cell-imbalance")
    req.ride_log.columns = [c for c in req.ride_log.columns if c != "imu_peak_g"]
    with pytest.raises(RideLogError, match="missing columns: imu_peak_g"):
        parse_ride_log(req.ride_log)


def test_hash_ignores_key_order_and_trailing_zero():
    a = {"rows": [[1.0, 2.5]], "format": "ridelog.v1"}
    b = {"format": "ridelog.v1", "rows": [[1, 2.5]]}
    assert ride_log_sha256(a) == ride_log_sha256(b)


def test_months_between():
    assert months_between(date(2025, 11, 15), date(2026, 10, 11)) == 10
    assert months_between(date(2025, 11, 10), date(2026, 10, 11)) == 11
    assert months_between(date(2027, 1, 1), date(2026, 1, 1)) == 0


def test_impact_fact_uses_the_minute_before_the_first_non_imu_fault(make_request):
    req = make_request("impact-before-fault")
    facts = vehicle_facts(req, parse_ride_log(req.ride_log))
    assert facts.first_fault_t == 322
    assert facts.max_g_before_first_fault == pytest.approx(9.4)


def test_water_fact_needs_humidity_and_moisture_code(make_request):
    req = make_request("water-ingress")
    assert vehicle_facts(req, parse_ride_log(req.ride_log)).water_exposure is True
    req2 = make_request("firmware-charge-stop")
    assert vehicle_facts(req2, parse_ride_log(req2.ride_log)).water_exposure is False
