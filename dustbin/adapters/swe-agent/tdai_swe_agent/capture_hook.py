from __future__ import annotations

from typing import Any

try:
    from sweagent.agent.hooks.abstract import AbstractAgentHook
except Exception:  # pragma: no cover - allows unit tests without SWE-agent installed
    class AbstractAgentHook:  # type: ignore[no-redef]
        def on_init(self, *, agent: Any) -> None:
            pass


from .audit import AuditLogger
from .client import TdaiGatewayClient
from .config import CaptureConfig
from .utils import content_to_text, first_problem_text, simplify_history_messages, trajectory_summary, truncate_text


class TdaiCaptureHook(AbstractAgentHook):
    def __init__(
        self,
        *,
        client: TdaiGatewayClient,
        config: CaptureConfig,
        session_key: str,
        session_id: str,
        user_id: str,
        instance_id: str,
        audit: AuditLogger | None = None,
    ) -> None:
        self.client = client
        self.config = config
        self.session_key = session_key
        self.session_id = session_id
        self.user_id = user_id
        self.instance_id = instance_id
        self.audit = audit
        self.agent: Any | None = None

    def on_init(self, *, agent: Any) -> None:
        self.agent = agent

    def on_run_done(self, *, trajectory: list[dict[str, Any]], info: dict[str, Any]) -> None:
        if not self.config.enabled:
            return
        history = list(getattr(self.agent, "history", [])) if self.agent is not None else []
        user_content = self._user_content(history)
        assistant_content = self._assistant_content(trajectory, info)
        messages = simplify_history_messages(history) if self.config.include_raw_history else None
        try:
            result = self.client.capture(
                user_content=user_content,
                assistant_content=assistant_content,
                session_key=self.session_key,
                session_id=self.session_id,
                user_id=self.user_id,
                messages=messages,
            )
            if self.audit:
                self.audit.event(
                    "capture",
                    {
                        "instance_id": self.instance_id,
                        "session_key": self.session_key,
                        "session_id": self.session_id,
                        "l0_recorded": result.l0_recorded,
                        "scheduler_notified": result.scheduler_notified,
                        "error": result.raw.get("_tdai_error"),
                    },
                )
                self.audit.capture_payload(
                    {
                        "request": {
                            "user_content_preview": truncate_text(user_content, 2000),
                            "assistant_content": assistant_content,
                            "session_key": self.session_key,
                            "session_id": self.session_id,
                            "user_id": self.user_id,
                            "message_count": len(messages or []),
                        },
                        "response": result.raw,
                    }
                )
            if self.config.session_end_after_instance:
                self.client.session_end(session_key=self.session_key, user_id=self.user_id)
        except Exception as exc:
            if self.audit:
                self.audit.event(
                    "capture_error",
                    {"instance_id": self.instance_id, "session_key": self.session_key, "error": str(exc)},
                )

    def _user_content(self, history: list[dict[str, Any]]) -> str:
        text = first_problem_text(history)
        if text:
            return text
        problem_statement = getattr(self.agent, "_problem_statement", None)
        if problem_statement is not None:
            if hasattr(problem_statement, "get_problem_statement"):
                try:
                    return str(problem_statement.get_problem_statement())
                except Exception:
                    pass
            return content_to_text(getattr(problem_statement, "text", ""))
        return self.instance_id

    def _assistant_content(self, trajectory: list[dict[str, Any]], info: dict[str, Any]) -> str:
        if self.config.include_trajectory_summary:
            return trajectory_summary(trajectory, info, max_chars=self.config.max_assistant_summary_chars)
        return truncate_text(str(info), self.config.max_assistant_summary_chars)
