"""Deterministic warranty rules.

The model proposes a root cause; these rules, and only these rules, decide
whether the repair is covered. The same function backs the check_warranty tool
and the guardrail that overwrites whatever warranty block the model returns.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .knowledge import Knowledge, parse_version
from .models import VehicleFacts

Decision = Literal["covered", "not_covered", "needs_inspection"]

CAUSE_CODES = (
    "BATTERY_CELL_IMBALANCE",
    "INVERTER_OVERCURRENT",
    "COOLANT_PUMP_FAILURE",
    "CHARGE_PORT_WATER_INGRESS",
    "THROTTLE_CONNECTOR_INTERMITTENT",
    "FIRMWARE_BELOW_MINIMUM",
    "IMPACT_DAMAGE",
    "UNDETERMINED",
)

# cause -> (clause, months, km limit or None)
COMPONENT_CLAUSE: dict[str, tuple[str, int, int | None]] = {
    "BATTERY_CELL_IMBALANCE": ("W2", 36, 30000),
    "INVERTER_OVERCURRENT": ("W3", 24, None),
    "COOLANT_PUMP_FAILURE": ("W4", 24, None),
    "THROTTLE_CONNECTOR_INTERMITTENT": ("W1", 24, None),
    "CHARGE_PORT_WATER_INGRESS": ("W1", 24, None),
}

IMPACT_G = 6.0
MIN_CONFIDENCE = 0.5


@dataclass(frozen=True)
class WarrantyDecision:
    decision: Decision
    clause: str
    reason: str

    def as_dict(self) -> dict[str, str]:
        return {"decision": self.decision, "clause": self.clause, "reason": self.reason}


def decide(cause_code: str, confidence: float, facts: VehicleFacts, kb: Knowledge) -> WarrantyDecision:
    if cause_code not in CAUSE_CODES:
        raise ValueError(f"unknown cause code {cause_code}")

    if cause_code == "IMPACT_DAMAGE" or facts.max_g_before_first_fault > IMPACT_G:
        return WarrantyDecision(
            "not_covered",
            "W6",
            f"Impact of {facts.max_g_before_first_fault:.1f} g recorded within 60 s before the first fault (limit {IMPACT_G:g} g).",
        )

    if cause_code == "CHARGE_PORT_WATER_INGRESS" and facts.water_exposure:
        return WarrantyDecision(
            "not_covered",
            "W7",
            "Charge port read wet at plug in with humidity at or above 95%: water from washing is excluded.",
        )

    if cause_code == "UNDETERMINED" or confidence < MIN_CONFIDENCE:
        return WarrantyDecision(
            "needs_inspection",
            "W1",
            f"Root cause not established with enough confidence ({confidence:.2f} < {MIN_CONFIDENCE}); a technician must inspect.",
        )

    if cause_code == "FIRMWARE_BELOW_MINIMUM":
        required = [
            b for b in kb.bulletins if b.get("min_firmware") and facts.model in b["models"] and parse_version(facts.firmware) < parse_version(b["min_firmware"])
        ]
        if required:
            ids = ", ".join(b["id"] for b in required)
            return WarrantyDecision("covered", "W5", f"Firmware {facts.firmware} is below the minimum in {ids}; the update is covered at no charge.")
        return WarrantyDecision("needs_inspection", "W5", f"Firmware {facts.firmware} meets every bulletin minimum, so a firmware defect is not shown.")

    clause, months, km = COMPONENT_CLAUSE[cause_code]
    if facts.age_months > months:
        return WarrantyDecision("not_covered", clause, f"Vehicle is {facts.age_months} months old; {clause} covers {months} months.")
    if km is not None and facts.odometer_km > km:
        return WarrantyDecision("not_covered", clause, f"Odometer {facts.odometer_km} km is over the {km} km limit in {clause}.")
    limit = f"{months} months" + (f" or {km:,} km" if km else "")
    return WarrantyDecision(
        "covered",
        clause,
        f"{kb.clauses[clause]['title']}: vehicle is {facts.age_months} months and {facts.odometer_km:,} km, inside {limit}.",
    )
