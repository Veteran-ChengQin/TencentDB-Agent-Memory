from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

from .utils import json_safe


class AuditLogger:
    def __init__(
        self,
        directory: Path,
        *,
        save_recall_payloads: bool = True,
        save_capture_payloads: bool = True,
    ) -> None:
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)
        self.save_recall_payloads = save_recall_payloads
        self.save_capture_payloads = save_capture_payloads
        self._lock = threading.Lock()
        self._seq = 0

    def event(self, event_type: str, payload: dict[str, Any]) -> None:
        record = {"ts": time.time(), "event": event_type, **json_safe(payload)}
        with self._lock:
            with (self.directory / "events.jsonl").open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")

    def recall_payload(self, payload: dict[str, Any]) -> None:
        if self.save_recall_payloads:
            self._write_payload("recall", payload)

    def capture_payload(self, payload: dict[str, Any]) -> None:
        if self.save_capture_payloads:
            self._write_payload("capture", payload)

    def _write_payload(self, prefix: str, payload: dict[str, Any]) -> None:
        with self._lock:
            self._seq += 1
            path = self.directory / f"{prefix}-{self._seq:04d}.json"
            path.write_text(
                json.dumps(json_safe(payload), ensure_ascii=False, indent=2, sort_keys=True),
                encoding="utf-8",
            )
