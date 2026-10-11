"""SQLite idempotency and run store.

One row per Idempotency-Key. A finished row is served again without a model
run. A row left `running` by an earlier process (the service was killed) is
taken over by the next attempt, because its boot id no longer matches.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  idempotency_key TEXT PRIMARY KEY,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  boot_id         TEXT NOT NULL,
  mode            TEXT NOT NULL,
  result_json     TEXT,
  spans_json      TEXT,
  run_json        TEXT,
  error_json      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_runs (
  day   TEXT PRIMARY KEY,
  live  INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0
);
"""

Begin = Literal["new", "done", "running", "mismatch"]


@dataclass(frozen=True)
class StoredRun:
    status: str
    result: dict[str, Any] | None
    spans: list[dict[str, Any]]
    run: dict[str, Any] | None
    error: dict[str, Any] | None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class RunStore:
    def __init__(self, path: str):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(SCHEMA)
        self._lock = threading.Lock()

    def begin(self, key: str, request_hash: str, boot_id: str, mode: str) -> tuple[Begin, StoredRun | None]:
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                row = self._db.execute(
                    "SELECT request_hash, status, boot_id FROM runs WHERE idempotency_key = ?", (key,)
                ).fetchone()
                if row is None:
                    self._db.execute(
                        "INSERT INTO runs (idempotency_key, request_hash, status, boot_id, mode, created_at, updated_at)"
                        " VALUES (?, ?, 'running', ?, ?, ?, ?)",
                        (key, request_hash, boot_id, mode, _now(), _now()),
                    )
                    self._db.execute("COMMIT")
                    return "new", None
                stored_hash, status, stored_boot = row
                if stored_hash != request_hash:
                    self._db.execute("COMMIT")
                    return "mismatch", None
                if status == "done":
                    self._db.execute("COMMIT")
                    return "done", self.get(key)
                if status == "running" and stored_boot == boot_id:
                    self._db.execute("COMMIT")
                    return "running", None
                # failed earlier, or abandoned by a process that died: take it over.
                self._db.execute(
                    "UPDATE runs SET status='running', boot_id=?, mode=?, error_json=NULL, updated_at=? WHERE idempotency_key=?",
                    (boot_id, mode, _now(), key),
                )
                self._db.execute("COMMIT")
                return "new", None
            except Exception:
                self._db.execute("ROLLBACK")
                raise

    def complete(self, key: str, result: dict[str, Any], spans: list[dict[str, Any]], run: dict[str, Any]) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE runs SET status='done', result_json=?, spans_json=?, run_json=?, updated_at=? WHERE idempotency_key=?",
                (json.dumps(result), json.dumps(spans), json.dumps(run), _now(), key),
            )

    def fail(self, key: str, error: dict[str, Any]) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE runs SET status='failed', error_json=?, updated_at=? WHERE idempotency_key=?",
                (json.dumps(error), _now(), key),
            )

    def get(self, key: str) -> StoredRun | None:
        row = self._db.execute(
            "SELECT status, result_json, spans_json, run_json, error_json FROM runs WHERE idempotency_key=?", (key,)
        ).fetchone()
        if row is None:
            return None
        status, result, spans, run, error = row
        return StoredRun(
            status=status,
            result=json.loads(result) if result else None,
            spans=json.loads(spans) if spans else [],
            run=json.loads(run) if run else None,
            error=json.loads(error) if error else None,
        )

    def count_model_run(self, live: bool) -> None:
        day = datetime.now(timezone.utc).date().isoformat()
        with self._lock:
            self._db.execute(
                "INSERT INTO model_runs (day, live, total) VALUES (?, ?, 1)"
                " ON CONFLICT(day) DO UPDATE SET live = live + excluded.live, total = total + 1",
                (day, 1 if live else 0),
            )

    def model_runs(self) -> dict[str, int]:
        day = datetime.now(timezone.utc).date().isoformat()
        today = self._db.execute("SELECT live, total FROM model_runs WHERE day=?", (day,)).fetchone() or (0, 0)
        total = self._db.execute("SELECT COALESCE(SUM(total), 0) FROM model_runs").fetchone()[0]
        return {"live_today": int(today[0]), "today": int(today[1]), "total": int(total)}

    def close(self) -> None:
        self._db.close()
