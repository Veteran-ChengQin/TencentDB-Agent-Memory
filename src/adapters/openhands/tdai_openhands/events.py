from __future__ import annotations

import json
import zipfile
from pathlib import Path
from typing import Any

from .utils import content_to_text, json_safe, truncate_text


def load_jsonish_file(path: str | Path) -> Any:
    file_path = Path(path)
    if file_path.suffix.lower() == ".jsonl":
        return [
            json.loads(line)
            for line in file_path.read_text(encoding="utf-8-sig").splitlines()
            if line.strip()
        ]
    return json.loads(file_path.read_text(encoding="utf-8-sig"))


def load_events_from_path(path: str | Path) -> list[dict[str, Any]]:
    file_path = Path(path)
    if file_path.suffix.lower() == ".zip":
        return _load_events_from_zip(file_path)
    data = load_jsonish_file(file_path)
    return normalize_events(data)


def normalize_events(data: Any) -> list[dict[str, Any]]:
    if data is None:
        return []
    if isinstance(data, list):
        return [event for event in data if isinstance(event, dict)]
    if isinstance(data, dict):
        for key in ("events", "items", "trajectory", "history"):
            value = data.get(key)
            if isinstance(value, list):
                return [event for event in value if isinstance(event, dict)]
        if _looks_like_event(data):
            return [data]
    return []


def summarize_events(events: list[dict[str, Any]], *, max_chars: int) -> str:
    if not events:
        return "OpenHands run finished. No events were provided to the TDAI adapter."
    lines = [f"OpenHands run finished with {len(events)} exported events."]
    for idx, event in enumerate(events[-20:], start=max(1, len(events) - 19)):
        lines.append(f"\n[event {idx}] {event_brief(event)}")
    return truncate_text("\n".join(lines), max_chars, marker="[tdai] OpenHands event summary truncated.")


def event_brief(event: dict[str, Any]) -> str:
    kind = str(event.get("kind") or event.get("type") or event.get("event_type") or event.get("source") or "event")
    role = str(event.get("role") or event.get("actor") or "")
    text = _event_text(event)
    prefix = f"{kind}"
    if role:
        prefix += f"/{role}"
    if text:
        return f"{prefix}: {truncate_text(text, 800)}"
    return f"{prefix}: {json.dumps(json_safe(event), ensure_ascii=False)[:800]}"


def messages_from_events(events: list[dict[str, Any]], *, max_content_chars: int = 4000) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    for event in events:
        role = _event_role(event)
        text = _event_text(event)
        if not text.strip():
            continue
        if "<tdai_recall_context>" in text:
            continue
        messages.append({"role": role, "content": truncate_text(text, max_content_chars)})
    return messages


def _load_events_from_zip(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    with zipfile.ZipFile(path) as archive:
        for name in archive.namelist():
            lower = name.lower()
            if not (lower.endswith(".json") or lower.endswith(".jsonl")):
                continue
            if not any(token in lower for token in ("event", "trajectory", "history")):
                continue
            raw = archive.read(name).decode("utf-8")
            try:
                data = [json.loads(line) for line in raw.splitlines() if line.strip()] if lower.endswith(".jsonl") else json.loads(raw)
            except json.JSONDecodeError:
                continue
            events.extend(normalize_events(data))
    return events


def _event_role(event: dict[str, Any]) -> str:
    raw = str(event.get("role") or event.get("source") or event.get("actor") or "").lower()
    if "assistant" in raw or "agent" in raw:
        return "assistant"
    if "tool" in raw or "observation" in raw or "env" in raw:
        return "tool"
    return "user"


def _event_text(event: dict[str, Any]) -> str:
    for key in ("content", "message", "text", "action", "observation", "thought", "tool_result"):
        value = event.get(key)
        text = content_to_text(value)
        if text.strip():
            return text
    nested = event.get("data") or event.get("payload") or event.get("args")
    if isinstance(nested, dict):
        for key in ("content", "message", "text", "action", "observation", "thought", "tool_result"):
            text = content_to_text(nested.get(key))
            if text.strip():
                return text
    return ""


def _looks_like_event(data: dict[str, Any]) -> bool:
    return any(key in data for key in ("kind", "type", "event_type", "source", "content", "message", "action"))
