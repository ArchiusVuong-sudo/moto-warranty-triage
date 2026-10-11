"""Load the synthetic scenarios in data/scenarios and turn one into a triage request."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .config import DATA_DIR
from .models import TriageRequest


def scenario_paths(data_dir: Path = DATA_DIR) -> list[Path]:
    return sorted((data_dir / "scenarios").glob("*.json"))


def load_scenario(scenario_id: str, data_dir: Path = DATA_DIR) -> dict[str, Any]:
    doc: dict[str, Any] = json.loads((data_dir / "scenarios" / f"{scenario_id}.json").read_text())
    return doc


def all_scenarios(data_dir: Path = DATA_DIR) -> list[dict[str, Any]]:
    return [json.loads(p.read_text()) for p in scenario_paths(data_dir)]


def scenario_request(doc: dict[str, Any], filed_at: datetime | None = None, claim_number: str = "WC-DEMO-0001") -> TriageRequest:
    """The request the claims API would send for this scenario: sale date is relative to filing."""
    filed = filed_at or datetime.now(timezone.utc)
    sale = (filed - timedelta(days=round(30.44 * doc["vehicle"]["sale_months_ago"]))).date()
    return TriageRequest.model_validate(
        {
            "claim_id": f"claim-{doc['id']}",
            "claim_number": claim_number,
            "filed_at": filed.isoformat(),
            "complaint": doc["complaint"],
            "vehicle": {
                "vin": doc["vehicle"]["vin"],
                "model": doc["vehicle"]["model"],
                "sale_date": sale.isoformat(),
                "odometer_km": doc["vehicle"]["odometer_km"],
            },
            "ride_log": doc["ride_log"],
        }
    )
