"""Live triage agent on the Claude Agent SDK.

Isolation: no built-in tools, only the four in-process tools, no setting
sources, no skills, strict MCP config, a fresh temp cwd, no session
persistence, a bounded number of turns and a permission mode that refuses
anything not pre-approved. `build_options` is a pure function so a test can
assert every one of these.
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import shutil
import tempfile
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from .config import Settings
from .contract import ContractError, validate_result
from .env import build_child_env
from .tools import ALLOWED_TOOL_NAMES, SERVER_NAME, SpanSink, TriageContext, build_sdk_tools

SYSTEM_PROMPT = """You triage warranty claims for service engineers at an electric motorcycle maker.
Work only from the tools. Steps:
1. Call analyze_telemetry once with no arguments. Call it again with a time window only if you need more detail.
2. Call lookup_fault_code for the fault codes that explain the complaint (at most 4 calls).
3. Call search_service_bulletins once with the main symptom and fault codes.
4. Choose exactly one root cause code and call check_warranty with it and your confidence.
5. Return the result object.
Evidence rules: cite telemetry by its window (ref like "t=312-318s") with the measured values, fault codes by code, bulletins by id, the warranty clause by id.
Parts and labour come from the matching bulletin. Copy the warranty decision, clause and reason from check_warranty unchanged.
If the data does not point to one cause, use UNDETERMINED with confidence below 0.5. Keep the summary under 70 words, plain English."""

TRANSIENT_STATUS = {408, 429, 500, 502, 503, 504, 529}


def build_prompt(ctx: TriageContext) -> str:
    req = ctx.request
    counts: dict[str, list[int]] = {}
    for f in ctx.telemetry.faults:
        counts.setdefault(f.code, []).append(f.t)
    faults = ", ".join(f"{c} x{len(ts)} (first t={ts[0]}s)" for c, ts in sorted(counts.items(), key=lambda x: x[1][0])) or "none"
    return (
        f"Claim {req.claim_number}\n"
        f"Bike: {req.vehicle.model}, VIN {req.vehicle.vin}, {ctx.facts.age_months} months old, {req.vehicle.odometer_km} km, firmware {ctx.telemetry.firmware}\n"
        f"Dealer complaint: {req.complaint}\n"
        f"Ride log: {ctx.telemetry.seconds} samples at {ctx.telemetry.hz} Hz. Fault codes: {faults}\n"
        "Triage this claim."
    )


def build_options(settings: Settings, server: Any, cwd: str, env: dict[str, str], schema: dict[str, Any]) -> Any:
    from claude_agent_sdk import ClaudeAgentOptions

    return ClaudeAgentOptions(
        tools=[],
        allowed_tools=list(ALLOWED_TOOL_NAMES),
        mcp_servers={SERVER_NAME: server},
        strict_mcp_config=True,
        setting_sources=[],
        skills=[],
        cwd=cwd,
        max_turns=settings.max_turns,
        max_budget_usd=1.0,
        permission_mode="dontAsk",
        env=env,
        model=settings.model,
        system_prompt=SYSTEM_PROMPT,
        output_format={"type": "json_schema", "schema": schema},
        extra_args={"no-session-persistence": None, "disable-slash-commands": None},
    )


class TransientModelError(Exception):
    """Overloaded, rate-limited or 5xx from the model API; worth a retry."""


class ModelRunError(Exception):
    """The run failed in a way a retry here will not fix."""


@dataclass
class LiveRun:
    result: dict[str, Any]
    meta: dict[str, Any]
    model_runs: int
    retries: list[str] = field(default_factory=list)


def _is_transient(exc: BaseException) -> bool:
    if isinstance(exc, TransientModelError):
        return True
    status = getattr(exc, "api_error_status", None)
    if isinstance(status, int) and status in TRANSIENT_STATUS:
        return True
    if getattr(exc, "terminal_reason", None) == "api_error":
        return True
    text = str(exc).lower()
    return any(w in text for w in ("overloaded", "rate limit", "529", "503", "502"))


async def _one_run(ctx: TriageContext, settings: Settings, sink: SpanSink, schema: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    from claude_agent_sdk import ResultMessage, create_sdk_mcp_server, query

    server = create_sdk_mcp_server(name=SERVER_NAME, version="1.0.0", tools=build_sdk_tools(ctx, sink))
    cwd = tempfile.mkdtemp(prefix="triage-run-")
    options = build_options(settings, server, cwd, build_child_env(os.environ), schema)
    t0 = time.perf_counter()
    result_msg: Any = None
    try:
        async for message in query(prompt=build_prompt(ctx), options=options):
            if isinstance(message, ResultMessage):
                result_msg = message
    finally:
        shutil.rmtree(cwd, ignore_errors=True)
    if result_msg is None:
        raise TransientModelError("model run ended without a result")
    if result_msg.is_error:
        status = result_msg.api_error_status
        if status in TRANSIENT_STATUS:
            raise TransientModelError(f"model API returned {status}")
        raise ModelRunError(f"model run failed: {result_msg.subtype} {result_msg.errors or ''}".strip())
    output = result_msg.structured_output
    if output is None and result_msg.result:
        try:
            output = json.loads(result_msg.result)
        except json.JSONDecodeError:
            output = None
    if not isinstance(output, dict):
        raise ContractError(["model returned no structured output"])
    usage = result_msg.usage or {}
    meta = {
        "model": settings.model,
        "duration_ms": result_msg.duration_ms or round((time.perf_counter() - t0) * 1000),
        "cost_usd": round(result_msg.total_cost_usd or 0.0, 5),
        "num_turns": result_msg.num_turns,
        "input_tokens": int(usage.get("input_tokens", 0)) + int(usage.get("cache_read_input_tokens", 0)) + int(usage.get("cache_creation_input_tokens", 0)),
        "output_tokens": int(usage.get("output_tokens", 0)),
    }
    return output, meta


async def run_live(
    ctx: TriageContext,
    settings: Settings,
    sink: SpanSink,
    schema: dict[str, Any],
    on_retry: Callable[[str], Awaitable[None]] | None = None,
    attempts: int = 3,
) -> LiveRun:
    """One triage with retries: backoff with full jitter on transient model errors,
    one more run if the output breaks the contract."""
    model_runs = 0
    retries: list[str] = []
    contract_failures = 0
    for i in range(attempts):
        model_runs += 1
        try:
            output, meta = await asyncio.wait_for(_one_run(ctx, settings, sink, schema), timeout=settings.run_timeout_s)
            validate_result(output)
            return LiveRun(result=output, meta=meta, model_runs=model_runs, retries=retries)
        except ContractError as e:
            contract_failures += 1
            if contract_failures >= 2:
                raise
            note = f"output broke the contract ({e.errors[0]}), running once more"
        except asyncio.TimeoutError as e:
            raise ModelRunError(f"model run took longer than {settings.run_timeout_s:g} s") from e
        except ModelRunError:
            raise
        except Exception as e:  # noqa: BLE001 - classified below
            if not _is_transient(e):
                raise ModelRunError(str(e)[:300]) from e
            if i == attempts - 1:
                raise TransientModelError(f"model unavailable after {attempts} tries: {str(e)[:120]}") from e
            note = f"transient model error ({str(e)[:80]}), backing off"
        retries.append(note)
        if on_retry:
            await on_retry(note)
        await asyncio.sleep(random.uniform(0, min(20.0, 2.0 * 2**i)))
    raise TransientModelError("model unavailable after retries")
