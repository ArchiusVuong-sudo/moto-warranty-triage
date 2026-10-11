"""Environment allowlist for the agent's CLI child process.

The SDK merges `options.env` over the parent's environment, so an allowlist in
`options.env` alone does not keep variables out. The service therefore also
scrubs its own environment at start (`scrub_process_env`), and the claims API
spawns it with the same allowlist.
"""

from __future__ import annotations

import os
from collections.abc import Mapping, MutableMapping

CHILD_ALLOWLIST = ("PATH", "HOME", "USER", "LANG", "TMPDIR", "ANTHROPIC_API_KEY")
SERVICE_PREFIXES = ("TRIAGE_",)
SERVICE_KEYS = ("DEMO_REPLAY",)


def build_child_env(source: Mapping[str, str]) -> dict[str, str]:
    """Only allowlisted keys, never CLAUDECODE or CLAUDE_CODE_*."""
    return {k: source[k] for k in CHILD_ALLOWLIST if k in source and source[k]}


def _keep(key: str) -> bool:
    if key == "CLAUDECODE" or key.startswith("CLAUDE_CODE_"):
        return False
    return key in CHILD_ALLOWLIST or key in SERVICE_KEYS or key.startswith(SERVICE_PREFIXES)


def scrub_process_env(environ: MutableMapping[str, str] = os.environ) -> list[str]:
    """Drop everything the service does not need. Returns the removed keys."""
    removed = [k for k in list(environ) if not _keep(k)]
    for k in removed:
        del environ[k]
    return removed
