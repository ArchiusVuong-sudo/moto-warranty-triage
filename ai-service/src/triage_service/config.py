"""Service settings, read once from the environment."""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = Path(os.environ.get("TRIAGE_DATA_DIR", REPO_ROOT / "data"))
FIXTURES_DIR = Path(os.environ.get("TRIAGE_FIXTURES_DIR", REPO_ROOT / "fixtures"))
CONTRACT_PATH = REPO_ROOT / "contracts" / "triage-result.v1.schema.json"

Mode = Literal["live", "replay"]


def login_available(env: dict[str, str] | None = None) -> bool:
    """True when a model call can work: an API key, or a local Claude Code login."""
    e = env if env is not None else dict(os.environ)
    if e.get("ANTHROPIC_API_KEY"):
        return True
    home = Path(e.get("HOME", str(Path.home())))
    cfg = home / ".claude.json"
    has_cli = shutil.which("claude", path=e.get("PATH")) is not None or _bundled_cli()
    if not cfg.exists() or not has_cli:
        return False
    try:
        return '"oauthAccount"' in cfg.read_text(errors="ignore")
    except OSError:
        return False


def _bundled_cli() -> bool:
    try:
        import claude_agent_sdk

        return (Path(claude_agent_sdk.__file__).parent / "_bundled").exists()
    except ImportError:  # pragma: no cover
        return False


def resolve_mode(env: dict[str, str] | None = None) -> Mode:
    """DEMO_REPLAY=1 or TRIAGE_MODE=replay force replay; TRIAGE_MODE=live forces live;
    otherwise live when a login is found, else replay."""
    e = env if env is not None else dict(os.environ)
    if e.get("DEMO_REPLAY") == "1" or e.get("TRIAGE_MODE") == "replay":
        return "replay"
    if e.get("TRIAGE_MODE") == "live":
        return "live"
    return "live" if login_available(e) else "replay"


@dataclass(frozen=True)
class Settings:
    mode: Mode
    model: str
    port: int
    db_path: str
    span_delay_ms: int
    max_turns: int
    run_timeout_s: float
    max_live_runs_per_day: int
    parent_pid: int | None

    @staticmethod
    def from_env(env: dict[str, str] | None = None) -> "Settings":
        e = env if env is not None else dict(os.environ)
        parent = e.get("TRIAGE_PARENT_PID")
        return Settings(
            mode=resolve_mode(e),
            model=e.get("TRIAGE_MODEL", "claude-sonnet-5-5"),
            port=int(e.get("TRIAGE_PORT", "4190")),
            db_path=e.get("TRIAGE_DB_PATH", str(REPO_ROOT / ".data" / "triage-service.sqlite")),
            span_delay_ms=int(e.get("TRIAGE_SPAN_DELAY_MS", "1400")),
            max_turns=int(e.get("TRIAGE_MAX_TURNS", "12")),
            run_timeout_s=float(e.get("TRIAGE_RUN_TIMEOUT_S", "180")),
            max_live_runs_per_day=int(e.get("TRIAGE_MAX_LIVE_RUNS_PER_DAY", "40")),
            parent_pid=int(parent) if parent else None,
        )
