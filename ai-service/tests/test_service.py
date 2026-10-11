"""HTTP behaviour of the triage service in replay mode: streaming, idempotency, drills, validation."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from triage_service.app import ReplyLost, TriageService, create_app
from triage_service.contract import contract_errors
from triage_service.store import RunStore


@pytest.fixture
def service(replay_settings):
    return TriageService(replay_settings, RunStore(":memory:"))


@pytest.fixture
def client(service):
    transport = httpx.ASGITransport(app=create_app(service))
    return httpx.AsyncClient(transport=transport, base_url="http://testclient")


def body_for(make_request, sid: str) -> dict[str, Any]:
    return make_request(sid).model_dump(mode="json")


async def post(client, body, key="job-1", **headers) -> tuple[int, list[dict[str, Any]], dict[str, Any] | None]:
    h = {"idempotency-key": key, **headers} if key else headers
    res = await client.post("/v1/triage", json=body, headers=h)
    if res.headers["content-type"].startswith("application/problem+json"):
        return res.status_code, [], res.json()
    return res.status_code, [json.loads(line) for line in res.text.splitlines() if line], None


async def test_health(client):
    res = await client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["mode"] == "replay" and data["fixtures"] == 7


async def test_stream_order_and_contract(client, make_request):
    status, lines, _ = await post(client, body_for(make_request, "cell-imbalance"), traceparent="00-" + "a" * 32 + "-" + "b" * 16 + "-01")
    assert status == 200
    types = [line["type"] for line in lines]
    assert types[0] == "accepted" and types[-1] == "result"
    assert set(types[1:-1]) == {"span"}
    assert lines[0]["trace_id"] == "a" * 32 and lines[0]["served_from_store"] is False
    spans = [line["span"] for line in lines if line["type"] == "span"]
    assert [s["seq"] for s in spans] == list(range(1, len(spans) + 1))
    assert all(s["replayed"] for s in spans)
    result = lines[-1]
    assert contract_errors(result["result"]) == []
    assert result["run"]["mode"] == "replay" and result["run"]["source"]["kind"] == "live"


async def test_same_key_is_served_from_the_store(client, make_request, service):
    body = body_for(make_request, "coolant-pump")
    _, first, _ = await post(client, body)
    _, again, _ = await post(client, body)
    assert again[0]["served_from_store"] is True
    assert again[-1]["run"]["model_runs"] == 0 and again[-1]["run"]["served_from_store"] is True
    assert again[-1]["result"] == first[-1]["result"]
    assert service.store.model_runs()["today"] == 1


async def test_same_key_different_body_is_422(client, make_request):
    await post(client, body_for(make_request, "coolant-pump"), key="k")
    status, _, problem = await post(client, body_for(make_request, "cell-imbalance"), key="k")
    assert status == 422 and problem["type"].endswith("idempotency-key-reused")


async def test_missing_key_is_400(client, make_request):
    status, _, problem = await post(client, body_for(make_request, "coolant-pump"), key=None)
    assert status == 400 and "Idempotency-Key" in problem["title"]


async def test_corrupt_export_is_422_with_reasons(client, make_request):
    status, _, problem = await post(client, body_for(make_request, "corrupt-export"))
    assert status == 422
    assert problem["type"].endswith("invalid-ride-log")
    assert len(problem["errors"]) == 3


async def test_bad_shape_is_422(client, make_request):
    body = body_for(make_request, "coolant-pump")
    body["vehicle"]["vin"] = "SHORT"
    status, _, problem = await post(client, body)
    assert status == 422 and problem["type"].endswith("invalid-request")


async def test_replay_refuses_unrecorded_input(client, make_request):
    body = body_for(make_request, "coolant-pump")
    body["ride_log"]["rows"][10][1] = 99.0
    status, _, problem = await post(client, body)
    assert status == 422 and problem["type"].endswith("no-replay-fixture")


async def test_lost_reply_is_recovered_from_the_store(client, make_request, service):
    body = body_for(make_request, "firmware-charge-stop")
    assert (await client.post("/admin/drills/lose-next-reply")).json() == {"armed": True}
    with pytest.raises((ReplyLost, httpx.HTTPError)):
        await post(client, body, key="lose-1")
    stored = service.store.get("lose-1")
    assert stored is not None and stored.status == "done"
    _, lines, _ = await post(client, body, key="lose-1")
    assert lines[0]["served_from_store"] is True and lines[-1]["run"]["model_runs"] == 0
    assert service.store.model_runs()["today"] == 1


async def test_run_in_progress_is_409(client, make_request, service):
    body = make_request("coolant-pump")
    service.store.begin("busy", body.request_hash(), service.boot_id, "replay")
    status, _, problem = await post(client, body.model_dump(mode="json"), key="busy")
    assert status == 409 and problem["type"].endswith("run-in-progress")


async def test_run_abandoned_by_a_dead_process_is_taken_over(client, make_request, service):
    body = make_request("coolant-pump")
    service.store.begin("orphan", body.request_hash(), "an-earlier-boot", "replay")
    status, lines, _ = await post(client, body.model_dump(mode="json"), key="orphan")
    assert status == 200 and lines[-1]["type"] == "result"


def test_store_begin_states():
    s = RunStore(":memory:")
    assert s.begin("a", "h1", "boot", "replay") == ("new", None)
    assert s.begin("a", "h1", "boot", "replay") == ("running", None)
    assert s.begin("a", "h2", "boot", "replay") == ("mismatch", None)
    s.fail("a", {"code": "x"})
    assert s.begin("a", "h1", "boot", "replay") == ("new", None)
    s.complete("a", {"r": 1}, [{"name": "t"}], {"m": 1})
    state, stored = s.begin("a", "h1", "boot", "replay")
    assert state == "done" and stored is not None and stored.result == {"r": 1}


def test_lose_reply_drill_logs_one_line_not_a_traceback():
    import logging
    import sys

    from triage_service.app import DrillLogFilter, ReplyLost

    try:
        raise ReplyLost("fault drill: reply dropped after the result was stored")
    except ReplyLost:
        drill = logging.LogRecord("uvicorn.error", logging.ERROR, __file__, 1, "Exception in ASGI application", (), sys.exc_info())
    try:
        raise ValueError("real bug")
    except ValueError:
        real = logging.LogRecord("uvicorn.error", logging.ERROR, __file__, 1, "Exception in ASGI application", (), sys.exc_info())
    f = DrillLogFilter()
    assert f.filter(drill) and f.filter(real)
    assert drill.exc_info is None and drill.levelname == "WARNING" and "reply dropped" in drill.getMessage()
    assert real.exc_info is not None and real.levelname == "ERROR"
