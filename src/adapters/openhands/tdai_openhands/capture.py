from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .audit import AuditLogger
from .client import CaptureResult, TdaiGatewayClient
from .config import CaptureConfig
from .events import messages_from_events, summarize_events
from .prompt import OpenHandsTask, build_recall_query
from .utils import json_safe, truncate_text


def build_capture_payload(
    *,
    task: OpenHandsTask,
    events: list[dict[str, Any]] | None,
    trajectory: Any | None,
    patch: str | None,
    metadata: dict[str, Any] | None,
    config: CaptureConfig,
) -> tuple[str, str, list[dict[str, str]] | None]:
    user_content = build_recall_query(task)
    assistant_content = _assistant_content(
        events=events or [],
        trajectory=trajectory,
        patch=patch,
        metadata=metadata or {},
        config=config,
    )
    messages = messages_from_events(events or []) if config.include_messages else None
    return user_content, assistant_content, messages


def capture_openhands_run(
    *,
    client: TdaiGatewayClient,
    task: OpenHandsTask,
    session_key: str,
    session_id: str,
    user_id: str,
    config: CaptureConfig,
    events: list[dict[str, Any]] | None = None,
    trajectory: Any | None = None,
    patch: str | None = None,
    metadata: dict[str, Any] | None = None,
    audit: AuditLogger | None = None,
) -> CaptureResult:
    user_content, assistant_content, messages = build_capture_payload(
        task=task,
        events=events,
        trajectory=trajectory,
        patch=patch,
        metadata=metadata,
        config=config,
    )
    result = client.capture(
        user_content=user_content,
        assistant_content=assistant_content,
        session_key=session_key,
        session_id=session_id,
        user_id=user_id,
        messages=messages,
    )
    if audit:
        audit.event(
            "capture",
            {
                "instance_id": task.instance_id,
                "session_key": session_key,
                "session_id": session_id,
                "l0_recorded": result.l0_recorded,
                "scheduler_notified": result.scheduler_notified,
                "error": result.raw.get("_tdai_error"),
                "message_count": len(messages or []),
            },
        )
        audit.capture_payload(
            {
                "request": {
                    "user_content_preview": truncate_text(user_content, 2000),
                    "assistant_content_preview": truncate_text(assistant_content, 4000),
                    "session_key": session_key,
                    "session_id": session_id,
                    "user_id": user_id,
                    "message_count": len(messages or []),
                },
                "response": result.raw,
            }
        )
    if config.session_end_after_capture:
        client.session_end(session_key=session_key, user_id=user_id)
    return result


def read_optional_text(path: str | Path | None) -> str | None:
    if not path:
        return None
    file_path = Path(path)
    if not file_path.exists():
        return None
    return file_path.read_text(encoding="utf-8", errors="replace")


def read_optional_json(path: str | Path | None) -> Any | None:
    if not path:
        return None
    file_path = Path(path)
    if not file_path.exists():
        return None
    return json.loads(file_path.read_text(encoding="utf-8-sig"))


def _assistant_content(
    *,
    events: list[dict[str, Any]],
    trajectory: Any | None,
    patch: str | None,
    metadata: dict[str, Any],
    config: CaptureConfig,
) -> str:
    parts = ["OpenHands run finished."]
    if metadata:
        parts.append("metadata:\n" + json.dumps(json_safe(metadata), ensure_ascii=False, indent=2, sort_keys=True))
    if config.include_events:
        parts.append(summarize_events(events, max_chars=config.max_assistant_summary_chars))
    if trajectory is not None:
        parts.append(
            "trajectory:\n"
            + truncate_text(
                json.dumps(json_safe(trajectory), ensure_ascii=False, indent=2, sort_keys=True),
                config.max_assistant_summary_chars,
            )
        )
    if config.include_patch and patch:
        parts.append("patch:\n" + truncate_text(patch, config.max_patch_chars, marker="[tdai] Patch truncated."))
    return truncate_text("\n\n".join(parts), config.max_assistant_summary_chars + config.max_patch_chars)
