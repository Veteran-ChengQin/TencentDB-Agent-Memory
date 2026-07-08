from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import sys
from typing import Any

from .client import MemorySearchResult, RecallResult
from .config import GatewayConfig, RecallConfig, ToolConfig
from .utils import content_to_text, strip_memory_tool_guide, truncate_text


@dataclass
class OpenHandsTask:
    instance_id: str
    problem_statement: str
    repo: str | None = None
    base_commit: str | None = None
    extra: dict[str, Any] | None = None


def build_recall_query(task: OpenHandsTask) -> str:
    parts = [
        "Platform: OpenHands",
        "Task type: SWE-bench bug fix",
        f"Instance: {task.instance_id}",
    ]
    if task.repo:
        parts.append(f"Repository: {task.repo}")
    if task.base_commit:
        parts.append(f"Base commit: {task.base_commit}")
    parts.append("Issue:")
    parts.append(task.problem_statement.strip())
    return "\n".join(parts).strip()


def compose_recall_context(
    *,
    recall: RecallResult | None,
    l1_search: MemorySearchResult | None,
    config: RecallConfig,
    tool_bundle_enabled: bool = False,
) -> str:
    parts: list[str] = []
    if l1_search and l1_search.results.strip():
        parts.append(
            "<relevant-memories>\n"
            "The following L1 memories were retrieved for this SWE-bench issue. "
            "Use them as background only and verify repository-specific facts in code and tests.\n\n"
            f"{l1_search.results.strip()}\n"
            "</relevant-memories>"
        )
    if recall and recall.context.strip():
        context = recall.context.strip()
        if config.strip_tool_guide_if_no_tool_bundle and not tool_bundle_enabled:
            context = strip_memory_tool_guide(context)
        parts.append(context)
    body = "\n\n".join(part for part in parts if part.strip()).strip()
    if not body:
        return ""
    wrapped = (
        "<tdai_recall_context>\n"
        "TencentDB Agent Memory recalled the following context before this OpenHands run. "
        "Use it only as background. The repository code, issue statement, and tests remain authoritative.\n\n"
        f"{body}\n"
        "</tdai_recall_context>"
    )
    return truncate_text(wrapped, config.max_context_chars, marker="[tdai] Recall context truncated.")


def inject_recall_into_text(task_text: str, recall_context: str, *, config: RecallConfig) -> str:
    if not recall_context.strip():
        return task_text
    if config.inject_position == "after_task":
        return f"{task_text.rstrip()}\n\n{recall_context}"
    return f"{recall_context}\n\n{task_text.lstrip()}"


def inject_recall_into_request(
    request_payload: dict[str, Any],
    recall_context: str,
    *,
    config: RecallConfig,
) -> dict[str, Any]:
    """Inject TDAI context into an OpenHands AppConversationStartRequest-like dict."""
    if not recall_context.strip():
        return dict(request_payload)
    payload = dict(request_payload)
    message = dict(payload.get("initial_message") or {})
    content = message.get("content")
    if content is None:
        text = ""
        new_content: Any = [{"type": "text", "text": inject_recall_into_text(text, recall_context, config=config)}]
    elif isinstance(content, str):
        new_content = inject_recall_into_text(content, recall_context, config=config)
    elif isinstance(content, list):
        text_index = _first_text_content_index(content)
        if text_index is None:
            new_content = [{"type": "text", "text": recall_context}, *content]
        else:
            new_content = [dict(item) if isinstance(item, dict) else item for item in content]
            item = dict(new_content[text_index])
            item["text"] = inject_recall_into_text(content_to_text(item), recall_context, config=config)
            new_content[text_index] = item
    else:
        new_content = inject_recall_into_text(content_to_text(content), recall_context, config=config)
    message["content"] = new_content
    message.setdefault("role", "user")
    message.setdefault("run", True)
    payload["initial_message"] = message
    return payload


def inject_tdai_mcp_config(
    request_payload: dict[str, Any],
    *,
    gateway: GatewayConfig,
    tools: ToolConfig,
) -> dict[str, Any]:
    """Attach the optional TDAI MCP memory-search server to an OpenHands request.

    This is intentionally opt-in. Existing recall-only requests stay unchanged
    unless ``tools.enabled`` is true in the adapter config.
    """
    if not tools.enabled:
        return dict(request_payload)
    payload = dict(request_payload)
    target_key = None
    if isinstance(payload.get("agent"), dict):
        target_key = "agent"
    elif isinstance(payload.get("agent_settings"), dict):
        target_key = "agent_settings"
    if target_key is None:
        return payload
    target = dict(payload[target_key])
    mcp_config = dict(target.get("mcp_config") or {})
    servers = dict(mcp_config.get("mcpServers") or {})
    server_name = tools.server_name or "tdai_search"
    if server_name not in servers:
        servers[server_name] = build_tdai_mcp_server_config(
            gateway=gateway,
            tools=tools,
        )
    mcp_config["mcpServers"] = servers
    target["mcp_config"] = mcp_config
    payload[target_key] = target
    return payload


def build_tdai_mcp_server_config(
    *,
    gateway: GatewayConfig,
    tools: ToolConfig,
) -> dict[str, Any]:
    adapter_root = Path(__file__).resolve().parents[1]
    server_script = (
        Path(tools.server_script).expanduser()
        if tools.server_script
        else adapter_root / "tools" / "tdai_search" / "tdai_mcp_server.py"
    )
    env = {
        "TDAI_GATEWAY_URL": tools.gateway_url or gateway.url,
        "TDAI_GATEWAY_API_KEY_ENV": tools.api_key_env or gateway.api_key_env,
        "TDAI_MEMORY_SEARCH_LIMIT": str(tools.memory_search_limit),
        "TDAI_CONVERSATION_SEARCH_LIMIT": str(tools.conversation_search_limit),
    }
    return {
        "command": tools.command or sys.executable,
        "args": [str(server_script)],
        "env": env,
    }


def _first_text_content_index(content: list[Any]) -> int | None:
    for idx, item in enumerate(content):
        if isinstance(item, dict) and (item.get("type") == "text" or "text" in item):
            return idx
    return None
