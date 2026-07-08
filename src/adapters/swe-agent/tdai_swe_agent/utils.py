from __future__ import annotations

import json
import re
from typing import Any


def content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks: list[str] = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "text":
                    chunks.append(str(item.get("text") or ""))
                elif item.get("type") == "image_url":
                    chunks.append("[image]")
                else:
                    chunks.append(json.dumps(json_safe(item), ensure_ascii=False))
            else:
                chunks.append(str(item))
        return "\n".join(part for part in chunks if part)
    return str(content)


def json_safe(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except TypeError:
        pass
    if hasattr(value, "model_dump"):
        return json_safe(value.model_dump())
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe(v) for v in value]
    return str(value)


def truncate_text(text: str, max_chars: int) -> str:
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    return text[: max_chars - 80].rstrip() + "\n\n[tdai] Context truncated by swe-agent adapter."


def strip_memory_tool_guide(context: str) -> str:
    if "tdai_memory_search" not in context and "tdai_conversation_search" not in context:
        return context

    lines = context.splitlines()
    filtered: list[str] = []
    skip_next_blank = False
    for line in lines:
        if "tdai_memory_search" in line or "tdai_conversation_search" in line:
            skip_next_blank = True
            continue
        if skip_next_blank and not line.strip():
            skip_next_blank = False
            continue
        if re.search(r"每轮对话中.*最多调用", line):
            continue
        filtered.append(line)
    return "\n".join(filtered).strip()


def first_problem_text(history: list[dict[str, Any]]) -> str:
    for item in history:
        if item.get("is_demo"):
            continue
        if item.get("message_type") != "observation":
            continue
        if item.get("role") not in {"user", "tool"}:
            continue
        text = content_to_text(item.get("content"))
        if text.strip():
            return text
    for item in history:
        if item.get("is_demo"):
            continue
        text = content_to_text(item.get("content"))
        if text.strip():
            return text
    return ""


def trajectory_summary(trajectory: list[dict[str, Any]], info: dict[str, Any], *, max_chars: int) -> str:
    parts = [
        "SWE-agent run finished.",
        f"exit_status: {info.get('exit_status', 'unknown')}",
        f"submission_present: {bool(info.get('submission'))}",
    ]
    if info.get("edited_files30"):
        parts.append(f"edited_files30: {info.get('edited_files30')}")
    if info.get("edited_files50"):
        parts.append(f"edited_files50: {info.get('edited_files50')}")
    if trajectory:
        parts.append(f"steps: {len(trajectory)}")
        last = trajectory[-1]
        action = content_to_text(last.get("action", ""))
        observation = content_to_text(last.get("observation", ""))
        parts.append("last_action:\n" + truncate_text(action, 1200))
        parts.append("last_observation:\n" + truncate_text(observation, 1200))
    if info.get("submission"):
        parts.append("submission:\n" + content_to_text(info.get("submission")))
    return truncate_text("\n\n".join(parts), max_chars)


def simplify_history_messages(history: list[dict[str, Any]]) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    for item in history:
        if "tdai_recall_context" in item.get("tags", []):
            continue
        role = str(item.get("role") or "user")
        content = content_to_text(item.get("content"))
        if not content.strip():
            continue
        messages.append({"role": role, "content": content})
    return messages
