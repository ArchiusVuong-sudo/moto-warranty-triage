"""Post-checks on the model's answer before it leaves the service."""

from __future__ import annotations

import copy
from typing import Any

from .rules import decide
from .tools import TriageContext


def enforce_rules(result: dict[str, Any], ctx: TriageContext) -> tuple[dict[str, Any], list[str]]:
    """Replace the warranty block with the rules' decision for the model's own root cause.

    The model may copy check_warranty's answer or not; either way money is decided here.
    """
    out = copy.deepcopy(result)
    notes: list[str] = []
    rc = out["root_cause"]
    ruled = decide(rc["code"], float(rc["confidence"]), ctx.facts, ctx.kb).as_dict()
    if out["warranty"] != ruled:
        changed = [k for k in ("decision", "clause") if out["warranty"].get(k) != ruled[k]]
        notes.append("warranty " + (", ".join(changed) if changed else "reason") + " set by rules, not the model")
    else:
        notes.append("warranty decision matches the rules")
    out["warranty"] = ruled
    if not ctx.warranty_checks:
        notes.append("model skipped check_warranty; rules applied anyway")
    return out, notes
