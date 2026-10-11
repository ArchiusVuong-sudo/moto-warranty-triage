"""Synthetic ride-log scenarios a dealer can file.

Run `python -m triage_service.synth` to rewrite data/scenarios/*.json. Output is
deterministic (fixed seeds, sorted keys), so a rerun with no code change is a
no-op diff. Every name, VIN and number here is invented.
"""

from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .config import DATA_DIR

COLUMNS = [
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
]

SECONDS = 600


@dataclass
class Sample:
    t: int
    speed_kmh: float = 0.0
    throttle_pct: float = 0.0
    current_a: float = 0.0
    pack_v: float = 352.0
    cell_min_v: float = 3.66
    cell_max_v: float = 3.70
    soc_pct: float = 80.0
    pack_temp_c: float = 28.0
    motor_temp_c: float = 45.0
    inverter_temp_c: float = 38.0
    coolant_temp_c: float = 35.0
    coolant_flow_lpm: float = 6.0
    imu_peak_g: float = 0.4
    humidity_pct: float = 55.0
    charge_power_kw: float = 0.0

    def row(self) -> list[float]:
        return [round(float(getattr(self, c)), 3) if c != "t" else self.t for c in COLUMNS]


@dataclass
class Scenario:
    id: str
    title: str
    complaint: str
    model: str
    vin: str
    sale_months_ago: int
    odometer_km: int
    firmware: str
    expected: dict[str, str]
    build: Callable[[random.Random], tuple[list[Sample], list[dict[str, object]]]]
    seed: int
    corrupt: bool = False
    tags: list[str] = field(default_factory=list)


def _ride(rng: random.Random, hard: float = 0.6) -> list[Sample]:
    """A 10 minute off-road ride with throttle bursts."""
    out: list[Sample] = []
    soc = 86.0
    motor = 48.0
    inverter = 40.0
    coolant = 36.0
    for t in range(SECONDS):
        burst = (math.sin(t / 9.0) + 1) / 2
        throttle = max(0.0, min(100.0, 35 + 60 * burst * hard + rng.uniform(-8, 8)))
        current = 40 + throttle * 3.1 + rng.uniform(-12, 12)
        speed = 25 + throttle * 0.55 + rng.uniform(-3, 3)
        soc -= current / 52000 * 100 / 3.6
        sag = current * 0.0011
        cell_mid = 3.45 + soc / 100 * 0.7 - sag
        motor += (current / 420 - (motor - 45) / 160) * 0.6
        inverter += (current / 520 - (inverter - 38) / 140) * 0.5
        coolant += ((motor - coolant) / 300) * 0.4 - (coolant - 34) / 900
        out.append(
            Sample(
                t=t,
                speed_kmh=speed,
                throttle_pct=throttle,
                current_a=current,
                pack_v=cell_mid * 96,
                cell_min_v=cell_mid - 0.012 - rng.uniform(0, 0.006),
                cell_max_v=cell_mid + 0.012 + rng.uniform(0, 0.006),
                soc_pct=soc,
                pack_temp_c=27 + t / 120 + rng.uniform(-0.2, 0.2),
                motor_temp_c=motor,
                inverter_temp_c=inverter,
                coolant_temp_c=coolant,
                coolant_flow_lpm=6.0 + rng.uniform(-0.25, 0.25),
                imu_peak_g=0.6 + abs(rng.gauss(0, 0.5)),
                humidity_pct=52 + rng.uniform(-2, 2),
            )
        )
    return out


def _charge(rng: random.Random, start_soc: float, humidity: float) -> list[Sample]:
    """A 10 minute DC charging session, bike parked."""
    out: list[Sample] = []
    soc = start_soc
    for t in range(SECONDS):
        power = 11.0 + rng.uniform(-0.3, 0.3)
        soc = min(100.0, soc + power / 15.6 / 36)
        cell_mid = 3.45 + soc / 100 * 0.7
        out.append(
            Sample(
                t=t,
                current_a=-power * 1000 / (cell_mid * 96),
                pack_v=cell_mid * 96,
                cell_min_v=cell_mid - 0.010,
                cell_max_v=cell_mid + 0.010,
                soc_pct=soc,
                pack_temp_c=24 + t / 200,
                motor_temp_c=26,
                inverter_temp_c=25,
                coolant_temp_c=24,
                coolant_flow_lpm=0.0,
                imu_peak_g=0.05,
                humidity_pct=humidity + rng.uniform(-1, 1),
                charge_power_kw=power,
            )
        )
    return out


def build_cell_imbalance(rng: random.Random) -> tuple[list[Sample], list[dict[str, object]]]:
    rows = _ride(rng, hard=0.9)
    faults: list[dict[str, object]] = []
    for s in rows:
        if s.current_a > 290:
            # One weak cell group sags far more than the rest under load.
            s.cell_min_v -= (s.current_a - 290) * 0.0028 + 0.09
        delta = (s.cell_max_v - s.cell_min_v) * 1000
        if delta > 150 and not any(f["t"] == s.t for f in faults) and len(faults) < 12:
            if not faults or s.t - int(faults[-1]["t"]) > 20:
                faults.append({"t": s.t, "code": "BMS-201"})
                faults.append({"t": s.t + 1, "code": "VCU-110"})
    for f in faults:
        if f["code"] == "VCU-110":
            for s in rows[int(f["t"]) : int(f["t"]) + 3]:
                s.current_a = 60
                s.throttle_pct = s.throttle_pct
                s.speed_kmh -= 6
    return rows, faults


def build_inverter_overcurrent(rng: random.Random) -> tuple[list[Sample], list[dict[str, object]]]:
    rows = _ride(rng, hard=0.8)
    faults: list[dict[str, object]] = []
    for t in (142, 263, 388, 507):
        rows[t].current_a = 515 + rng.uniform(0, 30)
        faults.append({"t": t, "code": "INV-301"})
        for s in rows[t + 1 : t + 3]:
            s.current_a = 0
            s.speed_kmh -= 9
    return rows, faults


def build_coolant_pump(rng: random.Random) -> tuple[list[Sample], list[dict[str, object]]]:
    rows = _ride(rng, hard=0.7)
    faults: list[dict[str, object]] = []
    motor = rows[180].motor_temp_c
    inverter = rows[180].inverter_temp_c
    coolant = rows[180].coolant_temp_c
    for s in rows[180:]:
        s.coolant_flow_lpm = max(0.1, 0.35 + rng.uniform(-0.15, 0.1))
        motor += s.current_a / 1100
        inverter += s.current_a / 2600
        coolant += 0.06
        s.motor_temp_c = min(motor, 152)
        s.inverter_temp_c = min(inverter, 99)
        s.coolant_temp_c = min(coolant, 82)
    for s in rows[180:]:
        if s.coolant_flow_lpm < 1.0 and not any(f["code"] == "COOL-501" for f in faults):
            faults.append({"t": s.t + 4, "code": "COOL-501"})
        if s.motor_temp_c > 140 and not any(f["code"] == "MOT-401" for f in faults):
            faults.append({"t": s.t, "code": "MOT-401"})
            faults.append({"t": s.t + 2, "code": "VCU-120"})
    for s in rows:
        if any(f["code"] == "VCU-120" and s.t > int(f["t"]) for f in faults):
            s.throttle_pct = min(s.throttle_pct, 20)
            s.current_a = min(s.current_a, 90)
    return rows, faults


def build_water_ingress(rng: random.Random) -> tuple[list[Sample], list[dict[str, object]]]:
    rows = _charge(rng, start_soc=31, humidity=97.5)
    faults: list[dict[str, object]] = [{"t": 2, "code": "CHG-701"}, {"t": 96, "code": "CHG-702"}]
    for s in rows[96:]:
        s.charge_power_kw = 0.0
        s.current_a = 0.0
        s.soc_pct = rows[95].soc_pct
    return rows, faults


def build_throttle_connector(rng: random.Random) -> tuple[list[Sample], list[dict[str, object]]]:
    rows = _ride(rng, hard=0.7)
    faults: list[dict[str, object]] = []
    for t in (77, 151, 233, 302, 371, 446, 529):
        rows[t].imu_peak_g = 2.6 + rng.uniform(0, 0.8)
        faults.append({"t": t, "code": "THR-601"})
        for s in rows[t : t + 2]:
            s.throttle_pct = 0.0
            s.current_a = 12.0
            s.speed_kmh -= 5
    return rows, faults


def build_firmware(rng: random.Random) -> tuple[list[Sample], list[dict[str, object]]]:
    rows = _charge(rng, start_soc=72, humidity=48)
    faults: list[dict[str, object]] = []
    stop_at: int | None = None
    for s in rows:
        if stop_at is None and s.soc_pct >= 80.0:
            stop_at = s.t
            faults.append({"t": s.t, "code": "BMS-210"})
            faults.append({"t": s.t + 1, "code": "FW-130"})
        if stop_at is not None:
            s.charge_power_kw = 0.0
            s.current_a = 0.0
            s.soc_pct = 80.0
    return rows, faults


def build_impact(rng: random.Random) -> tuple[list[Sample], list[dict[str, object]]]:
    rows = _ride(rng, hard=0.6)
    rows[318].imu_peak_g = 9.4
    rows[318].speed_kmh = 31
    for s in rows[319:]:
        s.speed_kmh = 0
        s.throttle_pct = 0
        s.current_a = 4
    faults: list[dict[str, object]] = [
        {"t": 318, "code": "IMU-801"},
        {"t": 320, "code": "IMU-802"},
        {"t": 322, "code": "DSP-901"},
        {"t": 323, "code": "CAN-950"},
    ]
    return rows, faults


def build_corrupt(rng: random.Random) -> tuple[list[Sample], list[dict[str, object]]]:
    rows, faults = build_cell_imbalance(rng)
    return rows, faults


SCENARIOS: list[Scenario] = [
    Scenario("cell-imbalance", "Power cuts under hard acceleration", "Customer reports the bike cuts power for a second under hard acceleration out of corners. Happens several times per ride.", "Ridgeback MX", "DEMORMX2500000101", 11, 4210, "4.1.2", {"cause": "BATTERY_CELL_IMBALANCE", "decision": "covered", "clause": "W2"}, build_cell_imbalance, 101),
    Scenario("inverter-overcurrent", "Motor cuts out and restarts at full throttle", "At full throttle the motor cuts out and comes back a moment later. No warning light stays on.", "Talus EN", "DEMOTEN2500000102", 8, 2980, "4.1.2", {"cause": "INVERTER_OVERCURRENT", "decision": "covered", "clause": "W3"}, build_inverter_overcurrent, 102),
    Scenario("coolant-pump", "Overheat warning on long climbs", "Overheat warning and reduced power on a long climb, then limp mode until restart.", "Talus EN", "DEMOTEN2400000103", 15, 7350, "4.1.2", {"cause": "COOLANT_PUMP_FAILURE", "decision": "covered", "clause": "W4"}, build_coolant_pump, 103),
    Scenario("water-ingress", "Charger trips after washing the bike", "Bike was washed this morning. Charging starts, then trips after about a minute and a half.", "Kestrel SM", "DEMOKSM2500000104", 6, 1870, "4.1.2", {"cause": "CHARGE_PORT_WATER_INGRESS", "decision": "not_covered", "clause": "W7"}, build_water_ingress, 104),
    Scenario("throttle-connector", "Throttle cuts in and out over bumps", "Throttle cuts in and out on rough ground. Fine on smooth roads.", "Kestrel SM", "DEMOKSM2500000105", 9, 3320, "4.1.2", {"cause": "THROTTLE_CONNECTOR_INTERMITTENT", "decision": "covered", "clause": "W1"}, build_throttle_connector, 105),
    Scenario("firmware-charge-stop", "Charging stops at 80%", "Charging always stops at 80 percent, on two different chargers.", "Ridgeback MX", "DEMORMX2400000106", 19, 9120, "3.9.4", {"cause": "FIRMWARE_BELOW_MINIMUM", "decision": "covered", "clause": "W5"}, build_firmware, 106),
    Scenario("impact-before-fault", "Display dead after a ride", "Display went blank during a trail ride and the bike will not show anything on the dash.", "Ridgeback MX", "DEMORMX2500000107", 7, 2440, "4.1.2", {"cause": "IMPACT_DAMAGE", "decision": "not_covered", "clause": "W6"}, build_impact, 107),
    Scenario("corrupt-export", "Corrupt telemetry export", "Power cuts under acceleration. Dealer tool crashed during the export.", "Talus EN", "DEMOTEN2500000108", 10, 3900, "4.1.2", {"cause": "REJECTED_INPUT", "decision": "dead_letter", "clause": "-"}, build_corrupt, 108, corrupt=True),
]


def ride_log_for(sc: Scenario) -> dict[str, object]:
    rng = random.Random(sc.seed)
    samples, faults = sc.build(rng)
    rows: list[list[object]] = [s.row() for s in samples]
    if sc.corrupt:
        # The export tool crashed: truncated rows, a time jump backwards, text in numeric fields.
        rows[200] = rows[200][:9]
        rows[201][0] = 150
        rows[350][5] = "NaN"
        rows = rows[:410]
    return {
        "format": "ridelog.v1",
        "hz": 1,
        "vin": sc.vin,
        "firmware": sc.firmware,
        "columns": COLUMNS,
        "rows": rows,
        "fault_codes": sorted(faults, key=lambda f: (int(f["t"]), str(f["code"]))),  # type: ignore[arg-type]
    }


def scenario_document(sc: Scenario) -> dict[str, object]:
    return {
        "_note": "Synthetic scenario for a demo. Vehicle, VIN and telemetry are invented.",
        "id": sc.id,
        "title": sc.title,
        "complaint": sc.complaint,
        "vehicle": {"vin": sc.vin, "model": sc.model, "sale_months_ago": sc.sale_months_ago, "odometer_km": sc.odometer_km},
        "expected": sc.expected,
        "ride_log": ride_log_for(sc),
    }


def write_all(out_dir: Path | None = None) -> list[Path]:
    target = out_dir or DATA_DIR / "scenarios"
    target.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for sc in SCENARIOS:
        p = target / f"{sc.id}.json"
        p.write_text(json.dumps(scenario_document(sc), sort_keys=True, separators=(",", ":")) + "\n")
        paths.append(p)
    return paths


if __name__ == "__main__":
    for path in write_all():
        print(path.name, path.stat().st_size)
