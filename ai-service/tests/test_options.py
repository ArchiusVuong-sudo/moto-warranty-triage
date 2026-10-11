"""The agent's isolation is asserted here, field by field."""

from __future__ import annotations

from dataclasses import replace

from triage_service.agent import SYSTEM_PROMPT, build_options, build_prompt
from triage_service.config import Settings, resolve_mode
from triage_service.contract import load_schema
from triage_service.env import CHILD_ALLOWLIST, build_child_env, scrub_process_env
from triage_service.tools import ALLOWED_TOOL_NAMES


def options(tmp_path):
    settings = replace(Settings.from_env({}), model="claude-haiku-5-5", max_turns=9)
    return build_options(settings, server={"type": "sdk"}, cwd=str(tmp_path), env={"PATH": "/usr/bin"}, schema=load_schema())


def test_no_builtin_tools_and_only_our_four(tmp_path):
    o = options(tmp_path)
    assert o.tools == []
    assert sorted(o.allowed_tools) == sorted(ALLOWED_TOOL_NAMES)
    assert len(o.allowed_tools) == 4
    assert all(t.startswith("mcp__triage__") for t in o.allowed_tools)
    assert list(o.mcp_servers) == ["triage"]


def test_no_settings_skills_or_foreign_mcp(tmp_path):
    o = options(tmp_path)
    assert o.setting_sources == []
    assert o.skills == []
    assert o.strict_mcp_config is True
    assert "disable-slash-commands" in o.extra_args


def test_bounded_and_locked_down(tmp_path):
    o = options(tmp_path)
    assert o.max_turns == 9
    assert o.max_budget_usd is not None and o.max_budget_usd <= 1.0
    assert o.permission_mode == "dontAsk"
    assert o.cwd == str(tmp_path)
    assert "no-session-persistence" in o.extra_args
    assert o.model == "claude-haiku-5-5"


def test_structured_output_uses_the_shared_contract(tmp_path):
    o = options(tmp_path)
    assert o.output_format == {"type": "json_schema", "schema": load_schema()}
    assert "check_warranty" in SYSTEM_PROMPT


def test_child_env_is_an_allowlist():
    source = {
        "PATH": "/bin",
        "HOME": "/home/x",
        "USER": "x",
        "LANG": "C",
        "TMPDIR": "/tmp",
        "ANTHROPIC_API_KEY": "test-value",
        "CLAUDECODE": "1",
        "CLAUDE_CODE_ENTRYPOINT": "cli",
        "AWS_SECRET_ACCESS_KEY": "nope",
        "GITHUB_TOKEN": "nope",
    }
    env = build_child_env(source)
    assert set(env) == set(CHILD_ALLOWLIST)
    assert "CLAUDECODE" not in env and "GITHUB_TOKEN" not in env


def test_scrub_keeps_service_config_and_drops_the_rest():
    environ = {"PATH": "/bin", "TRIAGE_PORT": "1", "DEMO_REPLAY": "1", "CLAUDE_CODE_SSE_PORT": "9", "CLAUDECODE": "1", "OPENAI_API_KEY": "x"}
    removed = scrub_process_env(environ)
    assert sorted(removed) == ["CLAUDECODE", "CLAUDE_CODE_SSE_PORT", "OPENAI_API_KEY"]
    assert environ == {"PATH": "/bin", "TRIAGE_PORT": "1", "DEMO_REPLAY": "1"}


def test_mode_resolution():
    assert resolve_mode({"DEMO_REPLAY": "1", "ANTHROPIC_API_KEY": "k"}) == "replay"
    assert resolve_mode({"TRIAGE_MODE": "replay", "ANTHROPIC_API_KEY": "k"}) == "replay"
    assert resolve_mode({"TRIAGE_MODE": "live"}) == "live"
    assert resolve_mode({"ANTHROPIC_API_KEY": "k"}) == "live"
    assert resolve_mode({"HOME": "/nonexistent", "PATH": "/nonexistent"}) == "replay"


def test_prompt_carries_facts_not_the_raw_log(make_ctx):
    prompt = build_prompt(make_ctx("cell-imbalance"))
    assert "BMS-201" in prompt and "Ridgeback MX" in prompt and "11 months" in prompt
    assert len(prompt) < 1200


def test_run_dirs_live_under_a_service_owned_root_and_old_ones_are_swept():
    import os
    import time

    from triage_service.agent import run_dirs_root, sweep_run_dirs

    root = run_dirs_root()
    old = root / "run-test-old"
    fresh = root / "run-test-fresh"
    old.mkdir(exist_ok=True)
    fresh.mkdir(exist_ok=True)
    past = time.time() - 7200
    os.utime(old, (past, past))
    sweep_run_dirs(older_than_s=3600)
    assert not old.exists() and fresh.exists()
    fresh.rmdir()
