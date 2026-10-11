from __future__ import annotations

import copy
from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

import pytest

from triage_service.config import Settings
from triage_service.knowledge import Knowledge, load_knowledge
from triage_service.models import TriageRequest, parse_ride_log, vehicle_facts
from triage_service.scenarios import load_scenario, scenario_request
from triage_service.tools import TriageContext

FILED = datetime(2026, 10, 11, 9, 0, tzinfo=UTC)


@pytest.fixture(scope="session")
def kb() -> Knowledge:
    return load_knowledge()


@pytest.fixture
def scenario() -> Callable[[str], dict[str, Any]]:
    return lambda sid: copy.deepcopy(load_scenario(sid))


@pytest.fixture
def make_request(scenario: Callable[[str], dict[str, Any]]) -> Callable[..., TriageRequest]:
    def build(sid: str, **vehicle: Any) -> TriageRequest:
        doc = scenario(sid)
        doc["vehicle"].update(vehicle)
        return scenario_request(doc, filed_at=FILED)

    return build


@pytest.fixture
def make_ctx(make_request: Callable[..., TriageRequest], kb: Knowledge) -> Callable[..., TriageContext]:
    def build(sid: str, **vehicle: Any) -> TriageContext:
        req = make_request(sid, **vehicle)
        tel = parse_ride_log(req.ride_log)
        return TriageContext(request=req, telemetry=tel, facts=vehicle_facts(req, tel), kb=kb)

    return build


@pytest.fixture
def replay_settings() -> Settings:
    return replace(Settings.from_env({"DEMO_REPLAY": "1"}), span_delay_ms=0, db_path=":memory:")
