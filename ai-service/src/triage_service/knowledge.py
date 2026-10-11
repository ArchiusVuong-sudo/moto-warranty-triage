"""Read-only knowledge the tools search: fault codes, service bulletins, warranty policy."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from .config import DATA_DIR


def parse_version(v: str) -> tuple[int, ...]:
    return tuple(int(p) for p in v.split("."))


_WORD = re.compile(r"[a-z0-9]+(?:-[0-9]+)?")
_STOP = {"the", "a", "an", "and", "or", "of", "on", "at", "to", "in", "is", "it", "for", "with", "after", "under", "over"}


def tokens(text: str) -> set[str]:
    return {w for w in _WORD.findall(text.lower()) if w not in _STOP}


@dataclass(frozen=True)
class Knowledge:
    fault_codes: dict[str, dict[str, Any]]
    bulletins: list[dict[str, Any]]
    clauses: dict[str, dict[str, Any]]

    def search_bulletins(self, query: str, model: str | None, limit: int = 3) -> list[dict[str, Any]]:
        q = tokens(query)
        scored: list[tuple[float, dict[str, Any]]] = []
        for b in self.bulletins:
            if model and model not in b["models"]:
                continue
            hay = tokens(b["title"] + " " + " ".join(b["symptoms"]) + " " + b["fix"])
            codes = {s.lower() for s in b["symptoms"] if re.fullmatch(r"[A-Z]{2,4}-[0-9]{3}", s)}
            score = len(q & hay) + 2 * len(q & codes)
            if score > 0:
                scored.append((score, b))
        scored.sort(key=lambda x: (-x[0], x[1]["id"]))
        return [b for _, b in scored[:limit]]

    def bulletin(self, bulletin_id: str) -> dict[str, Any] | None:
        return next((b for b in self.bulletins if b["id"] == bulletin_id), None)


@lru_cache(maxsize=4)
def load_knowledge(data_dir: Path = DATA_DIR) -> Knowledge:
    kdir = data_dir / "knowledge"
    codes = json.loads((kdir / "fault_codes.json").read_text())["codes"]
    bulletins = json.loads((kdir / "service_bulletins.json").read_text())["bulletins"]
    clauses = json.loads((kdir / "warranty_policy.json").read_text())["clauses"]
    return Knowledge(
        fault_codes={c["code"]: c for c in codes},
        bulletins=bulletins,
        clauses={c["id"]: c for c in clauses},
    )
