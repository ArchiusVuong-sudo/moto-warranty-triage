"""Request models and ride-log parsing.

The triage request is validated in two layers: pydantic checks the shape, then
`parse_ride_log` checks what pydantic cannot (row widths, time order, finite
numbers). Either failure is a 422, which the claims API treats as permanent and
dead-letters at once.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

REQUIRED_COLUMNS = (
    "t",
    "speed_kmh",
    "throttle_pct",
    "current_a",
    "pack_v",
    "cell_min_v",
    "cell_max_v",
    "soc_pct",
    "pack_temp_c",
    "motor_temp_c",
    "inverter_temp_c",
    "coolant_temp_c",
    "coolant_flow_lpm",
    "imu_peak_g",
    "humidity_pct",
    "charge_power_kw",
)


class FaultEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    t: int = Field(ge=0)
    code: str = Field(pattern=r"^[A-Z]{2,4}-[0-9]{3}$")


class RideLogIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    format: Literal["ridelog.v1"]
    hz: int = Field(ge=1, le=10)
    vin: str = Field(min_length=17, max_length=17)
    firmware: str = Field(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$")
    columns: list[str] = Field(min_length=2, max_length=40)
    rows: list[list[Any]] = Field(min_length=1, max_length=20000)
    fault_codes: list[FaultEvent] = Field(max_length=500)


class VehicleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    vin: str = Field(min_length=17, max_length=17)
    model: str = Field(min_length=2, max_length=40)
    sale_date: date
    odometer_km: int = Field(ge=0, le=500000)


class TriageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    claim_id: str = Field(min_length=1, max_length=64)
    claim_number: str = Field(min_length=1, max_length=32)
    filed_at: datetime
    complaint: str = Field(min_length=3, max_length=2000)
    vehicle: VehicleIn
    ride_log: RideLogIn

    def request_hash(self) -> str:
        return sha256_json(self.model_dump(mode="json"))

    def ride_log_hash(self) -> str:
        return ride_log_sha256(self.ride_log.model_dump(mode="json"))


def sha256_json(value: Any) -> str:
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode()).hexdigest()


def ride_log_sha256(ride_log: dict[str, Any]) -> str:
    return sha256_json(ride_log)


class RideLogError(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


@dataclass(frozen=True)
class Telemetry:
    """Column arrays of a validated ride log."""

    hz: int
    firmware: str
    series: dict[str, list[float]]
    faults: list[FaultEvent]

    @property
    def seconds(self) -> int:
        return len(self.series["t"])

    def at(self, name: str, i: int) -> float:
        return self.series[name][i]


def parse_ride_log(log: RideLogIn, max_errors: int = 8) -> Telemetry:
    errors: list[str] = []
    missing = [c for c in REQUIRED_COLUMNS if c not in log.columns]
    if missing:
        errors.append(f"missing columns: {', '.join(missing)}")
        raise RideLogError(errors)
    width = len(log.columns)
    if len(log.rows) < 30:
        errors.append(f"too few rows: {len(log.rows)} (need at least 30)")
    series: dict[str, list[float]] = {c: [] for c in log.columns}
    last_t: float | None = None
    for i, row in enumerate(log.rows):
        if len(errors) >= max_errors:
            break
        if len(row) != width:
            errors.append(f"row {i}: {len(row)} values, expected {width}")
            continue
        bad = False
        for c, v in zip(log.columns, row):
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
                errors.append(f"row {i}: column {c} is not a finite number ({v!r})")
                bad = True
                break
            series[c].append(float(v))
        if bad:
            continue
        t = float(row[0])
        if last_t is not None and t <= last_t:
            errors.append(f"row {i}: time goes backwards ({last_t:g} then {t:g})")
        last_t = t
    if errors:
        raise RideLogError(errors)
    return Telemetry(hz=log.hz, firmware=log.firmware, series=series, faults=list(log.fault_codes))


def months_between(start: date, end: date) -> int:
    months = (end.year - start.year) * 12 + (end.month - start.month)
    if end.day < start.day:
        months -= 1
    return max(0, months)


@dataclass(frozen=True)
class VehicleFacts:
    """Facts the warranty rules use. Computed from the request, never from the model."""

    age_months: int
    odometer_km: int
    firmware: str
    first_fault_t: int | None
    max_g_before_first_fault: float
    water_exposure: bool
    fault_codes: tuple[str, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "age_months": self.age_months,
            "odometer_km": self.odometer_km,
            "firmware": self.firmware,
            "first_fault_t": self.first_fault_t,
            "max_g_before_first_fault": round(self.max_g_before_first_fault, 2),
            "water_exposure": self.water_exposure,
            "fault_codes": list(self.fault_codes),
        }


def vehicle_facts(req: TriageRequest, tel: Telemetry) -> VehicleFacts:
    non_imu = [f for f in tel.faults if not f.code.startswith("IMU-")]
    first = min((f.t for f in non_imu), default=None)
    max_g = 0.0
    if first is not None:
        ts = tel.series["t"]
        g = tel.series["imu_peak_g"]
        max_g = max((g[i] for i in range(len(ts)) if first - 60 <= ts[i] <= first), default=0.0)
    early_humidity = max(tel.series["humidity_pct"][: 30 * tel.hz], default=0.0)
    codes = tuple(sorted({f.code for f in tel.faults}))
    return VehicleFacts(
        age_months=months_between(req.vehicle.sale_date, req.filed_at.date()),
        odometer_km=req.vehicle.odometer_km,
        firmware=tel.firmware,
        first_fault_t=first,
        max_g_before_first_fault=max_g,
        water_exposure=early_humidity >= 95.0 and "CHG-701" in codes,
        fault_codes=codes,
    )
