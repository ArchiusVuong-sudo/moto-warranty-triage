"""Run the triage service: `python -m triage_service` (127.0.0.1, TRIAGE_PORT)."""

from __future__ import annotations

import os
import signal
import sys
import threading
import time

import uvicorn

from .agent import sweep_run_dirs
from .app import TriageService, create_app
from .config import Settings
from .env import scrub_process_env
from .store import RunStore


def watch_parent(parent_pid: int) -> None:
    """Exit with the whole process group when the claims API that spawned us is gone,
    so no CLI child outlives it."""

    def loop() -> None:
        while True:
            time.sleep(1.0)
            if os.getppid() != parent_pid:
                try:
                    os.killpg(os.getpgid(0), signal.SIGTERM)
                finally:
                    os._exit(0)

    threading.Thread(target=loop, daemon=True, name="parent-watch").start()


def main() -> None:
    scrub_process_env()
    settings = Settings.from_env()
    if settings.parent_pid:
        watch_parent(settings.parent_pid)
    sweep_run_dirs()
    store = RunStore(settings.db_path)
    app = create_app(TriageService(settings, store))
    print(f"triage service on 127.0.0.1:{settings.port} mode={settings.mode}", file=sys.stderr, flush=True)
    uvicorn.run(app, host="127.0.0.1", port=settings.port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
