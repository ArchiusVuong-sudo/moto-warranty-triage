"""Replay mode: answers recorded from real live runs, no model call.

Fixtures live in fixtures/<scenario>.json and are written by
`python -m triage_service.record_fixtures`. A request is matched to a fixture
by the SHA-256 of its canonical ride log, so replay only answers inputs it has
really seen.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from .config import FIXTURES_DIR
from .tools import SpanSink


@dataclass(frozen=True)
class Fixture:
    scenario: str
    ride_log_sha256: str
    source: dict[str, Any]
    spans: list[dict[str, Any]]
    result: dict[str, Any]
    run: dict[str, Any]


def load_fixture(path: Path) -> Fixture:
    d = json.loads(path.read_text())
    return Fixture(
        scenario=d["scenario"],
        ride_log_sha256=d["ride_log_sha256"],
        source=d["source"],
        spans=d["spans"],
        result=d["result"],
        run=d["run"],
    )


@lru_cache(maxsize=4)
def fixture_index(fixtures_dir: Path = FIXTURES_DIR) -> dict[str, Fixture]:
    index: dict[str, Fixture] = {}
    if fixtures_dir.exists():
        for p in sorted(fixtures_dir.glob("*.json")):
            fx = load_fixture(p)
            index[fx.ride_log_sha256] = fx
    return index


class NoFixtureError(LookupError):
    pass


async def replay(fixture: Fixture, sink: SpanSink, delay_ms: int) -> tuple[dict[str, Any], dict[str, Any]]:
    for span in fixture.spans:
        if delay_ms:
            await asyncio.sleep(delay_ms / 1000)
        await sink({**span, "replayed": True})
    if delay_ms:
        await asyncio.sleep(delay_ms / 1000)
    meta = {**fixture.run, "replay_of": fixture.source}
    return fixture.result, meta
