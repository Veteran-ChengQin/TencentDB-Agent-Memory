from __future__ import annotations

import copy
from typing import Any

from .audit import AuditLogger
from .client import TdaiGatewayClient
from .config import RecallConfig
from .utils import first_problem_text, strip_memory_tool_guide, truncate_text


class TdaiRecallHistoryProcessor:
    """Inject TDAI recall context into SWE-agent's processed message view."""

    type = "tdai_recall"

    def __init__(
        self,
        *,
        client: TdaiGatewayClient,
        config: RecallConfig,
        session_key: str,
        user_id: str,
        instance_id: str,
        audit: AuditLogger | None = None,
    ) -> None:
        self.client = client
        self.config = config
        self.session_key = session_key
        self.user_id = user_id
        self.instance_id = instance_id
        self.audit = audit
        self._requested = False
        self._context = ""
        self._last_error: str | None = None

    def __call__(self, history: list[dict[str, Any]]) -> list[dict[str, Any]]:
        copied = copy.deepcopy(history)
        if not self.config.enabled:
            return copied
        context = self._get_context(copied)
        if not context:
            return copied
        return self._inject_context(copied, context)

    def _get_context(self, history: list[dict[str, Any]]) -> str:
        if self.config.mode == "once_per_instance" and self._requested:
            return self._context
        self._requested = True
        query = first_problem_text(history)
        if not query:
            return ""
        try:
            result = self.client.recall(query=query, session_key=self.session_key, user_id=self.user_id)
            l1_context = self._get_l1_search_context(query)
            context = _join_context_parts(l1_context, result.context)
            if self.config.strip_tool_guide_if_no_tool_bundle:
                context = strip_memory_tool_guide(context)
            context = truncate_text(context.strip(), self.config.max_context_chars)
            self._context = context
            if self.audit:
                self.audit.event(
                    "recall",
                    {
                        "instance_id": self.instance_id,
                        "session_key": self.session_key,
                        "strategy": result.strategy,
                        "memory_count": result.memory_count,
                        "context_chars": len(context),
                        "error": result.raw.get("_tdai_error"),
                        "l1_search_enabled": self.config.include_l1_search,
                    },
                )
                self.audit.recall_payload(
                    {
                        "request": {
                            "query_preview": truncate_text(query, 2000),
                            "session_key": self.session_key,
                            "user_id": self.user_id,
                        },
                        "response": result.raw,
                        "injected_context": context,
                    }
                )
            return context
        except Exception as exc:
            self._last_error = str(exc)
            if self.audit:
                self.audit.event(
                    "recall_error",
                    {"instance_id": self.instance_id, "session_key": self.session_key, "error": str(exc)},
                )
            return ""

    def _get_l1_search_context(self, query: str) -> str:
        if not self.config.include_l1_search:
            return ""
        try:
            result = self.client.search_memories(query=query, limit=self.config.l1_search_limit)
        except Exception as exc:
            if self.audit:
                self.audit.event(
                    "l1_search_error",
                    {"instance_id": self.instance_id, "session_key": self.session_key, "error": str(exc)},
                )
            return ""
        results = result.results.strip()
        if not results:
            if self.audit:
                self.audit.event(
                    "l1_search",
                    {
                        "instance_id": self.instance_id,
                        "session_key": self.session_key,
                        "strategy": result.strategy,
                        "total": result.total,
                        "context_chars": 0,
                        "error": result.raw.get("_tdai_error"),
                    },
                )
            return ""
        context = (
            "<relevant-memories>\n"
            "The following L1 memories were retrieved for this SWE-bench issue. "
            "Use them as background only and verify repo-specific facts in the workspace.\n\n"
            f"{results}\n"
            "</relevant-memories>"
        )
        if self.audit:
            self.audit.event(
                "l1_search",
                {
                    "instance_id": self.instance_id,
                    "session_key": self.session_key,
                    "strategy": result.strategy,
                    "total": result.total,
                    "context_chars": len(context),
                    "error": result.raw.get("_tdai_error"),
                },
            )
        return context

    def _inject_context(self, history: list[dict[str, Any]], context: str) -> list[dict[str, Any]]:
        if any("tdai_recall_context" in item.get("tags", []) for item in history):
            return history
        agent_name = _agent_name(history)
        injected = {
            "role": "user",
            "content": (
                "<tdai_recall_context>\n"
                "The following memory context was recalled before this SWE-bench instance. "
                "Treat it as background only; verify all repo-specific facts in the workspace.\n\n"
                f"{context}\n"
                "</tdai_recall_context>"
            ),
            "agent": agent_name,
            "message_type": "observation",
            "tags": ["tdai_recall_context", "keep_output"],
        }
        index = _insertion_index_after_instance_prompt(history)
        return history[:index] + [injected] + history[index:]


def insert_recall_processor(agent: Any, processor: TdaiRecallHistoryProcessor) -> None:
    processors = list(getattr(agent, "history_processors", []))
    insert_at = len(processors)
    for idx, existing in enumerate(processors):
        existing_type = getattr(existing, "type", None)
        if existing_type == "cache_control" or existing.__class__.__name__ == "CacheControlHistoryProcessor":
            insert_at = idx
            break
    processors.insert(insert_at, processor)
    agent.history_processors = processors


def _agent_name(history: list[dict[str, Any]]) -> str:
    for item in history:
        if item.get("agent"):
            return str(item["agent"])
    return "main"


def _insertion_index_after_instance_prompt(history: list[dict[str, Any]]) -> int:
    for idx, item in enumerate(history):
        if item.get("is_demo"):
            continue
        if item.get("message_type") == "observation" and item.get("role") in {"user", "tool"}:
            return idx + 1
    return len(history)


def _join_context_parts(*parts: str) -> str:
    return "\n\n".join(part.strip() for part in parts if part and part.strip())
