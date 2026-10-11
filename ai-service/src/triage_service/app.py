"""HTTP wrapper around the triage agent.

POST /v1/triage streams NDJSON: `accepted`, one `span` per tool call, optional
`note` lines, then `result` or `error`. The run is a task of its own, not of
the request, so a client that drops mid-stream does not lose a paid model run:
the result lands in the idempotency store and the retry is served from there.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import ValidationError

from .agent import ModelRunError, TransientModelError
from .config import Settings
from .contract import ContractError, load_schema
from .knowledge import Knowledge, load_knowledge
from .models import RideLogError, TriageRequest, parse_ride_log, vehicle_facts
from .pipeline import triage_once
from .replay import Fixture, fixture_index
from .store import RunStore
from .tools import TriageContext

PROBLEM = "application/problem+json"


def problem(status: int, title: str, detail: str, kind: str, **extra: Any) -> JSONResponse:
    body = {"type": f"https://errors.triage.local/{kind}", "title": title, "status": status, "detail": detail, **extra}
    return JSONResponse(body, status_code=status, media_type=PROBLEM)


@dataclass
class RunHandle:
    queue: asyncio.Queue[dict[str, Any] | None] = field(default_factory=asyncio.Queue)
    task: asyncio.Task[None] | None = None


@dataclass
class Drills:
    lose_next_reply: bool = False


class TriageService:
    def __init__(self, settings: Settings, store: RunStore, kb: Knowledge | None = None, fixtures: dict[str, Fixture] | None = None):
        self.settings = settings
        self.store = store
        self.kb = kb or load_knowledge()
        self.fixtures = fixtures if fixtures is not None else fixture_index()
        self.boot_id = uuid.uuid4().hex
        self.drills = Drills()
        self.runs: dict[str, RunHandle] = {}
        self.tasks: set[asyncio.Task[None]] = set()
        self.schema = load_schema()

    async def execute(self, key: str, ctx: TriageContext, fixture: Fixture | None, handle: RunHandle, trace_id: str | None) -> None:
        spans: list[dict[str, Any]] = []

        async def sink(span: dict[str, Any]) -> None:
            s = {**span, "trace_id": trace_id, "seq": len(spans) + 1}
            spans.append(s)
            await handle.queue.put({"type": "span", "span": s})

        async def note(message: str) -> None:
            await handle.queue.put({"type": "note", "message": message})

        try:
            outcome = await triage_once(ctx, self.settings, sink, fixture=fixture, on_retry=note)
            for _ in range(outcome.live_model_runs):
                self.store.count_model_run(live=True)
            if not outcome.live_model_runs:
                self.store.count_model_run(live=False)
            run = {**outcome.run, "model_output": outcome.model_output}
            self.store.complete(key, outcome.result, spans, run)
            await handle.queue.put({"type": "result", "result": outcome.result, "run": run})
        except ContractError as e:
            await self._fail(key, handle, "contract_violation", f"result broke the contract: {e.errors[0]}", retryable=False)
        except TransientModelError as e:
            await self._fail(key, handle, "model_unavailable", str(e), retryable=True)
        except ModelRunError as e:
            await self._fail(key, handle, "model_failed", str(e), retryable=False)
        except Exception as e:  # noqa: BLE001 - reported to the caller, who decides on retry
            await self._fail(key, handle, "internal", f"{type(e).__name__}: {e}"[:300], retryable=True)
        finally:
            await handle.queue.put(None)
            self.runs.pop(key, None)

    async def _fail(self, key: str, handle: RunHandle, code: str, message: str, retryable: bool) -> None:
        error = {"code": code, "message": message, "retryable": retryable}
        self.store.fail(key, error)
        await handle.queue.put({"type": "error", **error})


def ndjson(line: dict[str, Any]) -> bytes:
    return (json.dumps(line, separators=(",", ":")) + "\n").encode()


class ReplyLost(Exception):
    """Raised inside the stream to drop the connection on purpose (fault drill)."""


def create_app(service: TriageService) -> FastAPI:
    app = FastAPI(title="Triage service", version="1.0.0", docs_url="/docs")
    app.state.service = service

    @app.get("/health")
    async def health() -> dict[str, Any]:
        s = service.settings
        return {
            "status": "ok",
            "mode": s.mode,
            "model": s.model if s.mode == "live" else None,
            "boot_id": service.boot_id,
            "in_flight": len(service.runs),
            "fixtures": len(service.fixtures),
            "model_runs": service.store.model_runs(),
            "live_run_cap_per_day": s.max_live_runs_per_day,
        }

    @app.post("/admin/drills/lose-next-reply")
    async def arm_lose_next_reply(request: Request) -> dict[str, Any]:
        if request.client and request.client.host not in ("127.0.0.1", "::1", "testclient"):
            return {"armed": False}
        service.drills.lose_next_reply = True
        return {"armed": True}

    @app.post("/v1/triage")
    async def triage(
        request: Request,
        idempotency_key: str | None = Header(default=None),
        traceparent: str | None = Header(default=None),
    ) -> Any:
        if not idempotency_key or len(idempotency_key) > 200:
            return problem(400, "Idempotency-Key required", "Send a stable Idempotency-Key per job.", "idempotency-key-required")
        try:
            body = await request.json()
        except json.JSONDecodeError:
            return problem(400, "Invalid JSON", "Body is not JSON.", "invalid-json")
        try:
            req = TriageRequest.model_validate(body)
        except ValidationError as e:
            errs = [f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in e.errors()][:8]
            return problem(422, "Invalid triage request", "; ".join(errs), "invalid-request", errors=errs)
        try:
            tel = parse_ride_log(req.ride_log)
        except RideLogError as e:
            return problem(422, "Ride log failed validation", "; ".join(e.errors), "invalid-ride-log", errors=e.errors)

        fixture: Fixture | None = None
        if service.settings.mode == "replay":
            fixture = service.fixtures.get(req.ride_log_hash())
            if fixture is None:
                return problem(422, "No replay fixture", "Replay mode only answers ride logs recorded from a live run.", "no-replay-fixture")

        state, stored = service.store.begin(idempotency_key, req.request_hash(), service.boot_id, service.settings.mode)
        if state == "mismatch":
            return problem(422, "Idempotency-Key reused", "This key was used with a different request body.", "idempotency-key-reused")
        if state == "running":
            return problem(409, "Run in progress", "A run for this key is still going. Retry later.", "run-in-progress")

        trace_id = traceparent.split("-")[1] if traceparent and traceparent.count("-") >= 3 else None
        accepted = {"type": "accepted", "idempotency_key": idempotency_key, "mode": service.settings.mode, "trace_id": trace_id}

        if state == "done" and stored is not None:
            run = {**(stored.run or {}), "served_from_store": True, "model_runs": 0}

            async def from_store() -> AsyncIterator[bytes]:
                yield ndjson({**accepted, "served_from_store": True})
                for span in stored.spans:
                    yield ndjson({"type": "span", "span": {**span, "from_store": True}})
                yield ndjson({"type": "result", "result": stored.result, "run": run})

            return StreamingResponse(from_store(), media_type="application/x-ndjson")

        if service.settings.mode == "live" and service.store.model_runs()["live_today"] >= service.settings.max_live_runs_per_day:
            service.store.fail(idempotency_key, {"code": "live_cap", "message": "daily live run cap reached", "retryable": False})
            return problem(403, "Daily live run cap reached", "Set TRIAGE_MAX_LIVE_RUNS_PER_DAY or use replay mode.", "live-run-cap")

        ctx = TriageContext(request=req, telemetry=tel, facts=vehicle_facts(req, tel), kb=service.kb)
        handle = RunHandle()
        service.runs[idempotency_key] = handle
        handle.task = asyncio.create_task(service.execute(idempotency_key, ctx, fixture, handle, trace_id))
        service.tasks.add(handle.task)
        handle.task.add_done_callback(service.tasks.discard)

        async def live_stream() -> AsyncIterator[bytes]:
            yield ndjson({**accepted, "served_from_store": False})
            while True:
                line = await handle.queue.get()
                if line is None:
                    return
                if line["type"] == "result" and service.drills.lose_next_reply:
                    service.drills.lose_next_reply = False
                    raise ReplyLost("fault drill: reply dropped after the result was stored")
                yield ndjson(line)

        return StreamingResponse(live_stream(), media_type="application/x-ndjson")

    return app
