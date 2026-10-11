"""Opt-in smoke test on the real model: LIVE=1 uv run pytest tests/test_live.py"""

from __future__ import annotations

import os
from dataclasses import replace

import pytest

from triage_service.config import Settings
from triage_service.contract import contract_errors
from triage_service.pipeline import triage_once

pytestmark = pytest.mark.skipif(os.environ.get("LIVE") != "1", reason="set LIVE=1 to call the model")


async def test_live_triage_of_one_scenario(make_ctx):
    settings = replace(Settings.from_env(), mode="live")
    ctx = make_ctx("inverter-overcurrent")
    spans = []

    async def sink(s):
        spans.append(s["name"])

    out = await triage_once(ctx, settings, sink)
    assert contract_errors(out.result) == []
    assert out.result["root_cause"]["code"] == "INVERTER_OVERCURRENT"
    assert out.result["warranty"]["clause"] == "W3"
    assert "analyze_telemetry" in spans and out.run["mode"] == "live" and out.run["cost_usd"] > 0
