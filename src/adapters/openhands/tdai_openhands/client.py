from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

from .config import GatewayConfig, OpenHandsApiConfig


@dataclass
class RecallResult:
    context: str = ""
    strategy: str | None = None
    memory_count: int = 0
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class MemorySearchResult:
    results: str = ""
    total: int = 0
    strategy: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class CaptureResult:
    l0_recorded: int = 0
    scheduler_notified: bool = False
    raw: dict[str, Any] = field(default_factory=dict)


class TdaiGatewayClient:
    def __init__(self, config: GatewayConfig) -> None:
        self.config = config
        self.base_url = config.url.rstrip("/")

    def health(self) -> dict[str, Any]:
        return self._request("GET", "/health", None)

    def recall(self, *, query: str, session_key: str, user_id: str | None = None) -> RecallResult:
        payload: dict[str, Any] = {"query": query, "session_key": session_key}
        if user_id:
            payload["user_id"] = user_id
        data = self._request("POST", "/recall", payload)
        return RecallResult(
            context=str(data.get("context") or ""),
            strategy=data.get("strategy"),
            memory_count=int(data.get("memory_count") or 0),
            raw=data,
        )

    def search_memories(
        self,
        *,
        query: str,
        limit: int | None = None,
        memory_type: str | None = None,
        scene: str | None = None,
    ) -> MemorySearchResult:
        payload: dict[str, Any] = {"query": query}
        if limit is not None:
            payload["limit"] = limit
        if memory_type:
            payload["type"] = memory_type
        if scene:
            payload["scene"] = scene
        data = self._request("POST", "/search/memories", payload)
        return MemorySearchResult(
            results=str(data.get("results") or ""),
            total=int(data.get("total") or 0),
            strategy=data.get("strategy"),
            raw=data,
        )

    def search_conversations(
        self,
        *,
        query: str,
        limit: int | None = None,
        session_key: str | None = None,
    ) -> MemorySearchResult:
        payload: dict[str, Any] = {"query": query}
        if limit is not None:
            payload["limit"] = limit
        if session_key:
            payload["session_key"] = session_key
        data = self._request("POST", "/search/conversations", payload)
        return MemorySearchResult(
            results=str(data.get("results") or ""),
            total=int(data.get("total") or 0),
            strategy=None,
            raw=data,
        )

    def capture(
        self,
        *,
        user_content: str,
        assistant_content: str,
        session_key: str,
        session_id: str | None = None,
        user_id: str | None = None,
        messages: list[Any] | None = None,
    ) -> CaptureResult:
        payload: dict[str, Any] = {
            "user_content": user_content,
            "assistant_content": assistant_content,
            "session_key": session_key,
        }
        if session_id:
            payload["session_id"] = session_id
        if user_id:
            payload["user_id"] = user_id
        if messages is not None:
            payload["messages"] = messages
        data = self._request("POST", "/capture", payload)
        return CaptureResult(
            l0_recorded=int(data.get("l0_recorded") or 0),
            scheduler_notified=bool(data.get("scheduler_notified")),
            raw=data,
        )

    def session_end(self, *, session_key: str, user_id: str | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"session_key": session_key}
        if user_id:
            payload["user_id"] = user_id
        return self._request("POST", "/session/end", payload)

    def _request(self, method: str, path: str, payload: dict[str, Any] | None) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        headers = {"Accept": "application/json"}
        body: bytes | None = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        api_key = self.config.resolved_api_key()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.config.timeout_seconds) as response:
                text = response.read().decode("utf-8")
                return json.loads(text) if text else {}
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
            if self.config.fail_open:
                return {"_tdai_error": str(exc)}
            raise


class OpenHandsApiClient:
    """Small optional client for OpenHands App Server REST APIs.

    The adapter does not depend on OpenHands internals. This client is only used
    when callers want to patch request JSON or fetch an exported trajectory over
    HTTP instead of using files.
    """

    def __init__(self, config: OpenHandsApiConfig) -> None:
        if not config.app_server_url:
            raise ValueError("openhands.app_server_url is required")
        self.config = config
        self.base_url = config.app_server_url.rstrip("/")

    def start_conversation(self, request_payload: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", "/api/conversations", request_payload)

    def download_conversation(self, conversation_id: str) -> bytes:
        return self._request_bytes("GET", f"/api/conversations/{conversation_id}/download", None)

    def _request(self, method: str, path: str, payload: dict[str, Any] | None) -> dict[str, Any]:
        data = self._request_bytes(method, path, payload)
        text = data.decode("utf-8")
        return json.loads(text) if text else {}

    def _request_bytes(self, method: str, path: str, payload: dict[str, Any] | None) -> bytes:
        headers = {"Accept": "application/json"}
        body: bytes | None = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        api_key = self.config.resolved_session_api_key()
        if api_key:
            headers["X-Session-API-Key"] = api_key
            headers["Authorization"] = f"Bearer {api_key}"
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            headers=headers,
            method=method,
        )
        with urllib.request.urlopen(request, timeout=self.config.timeout_seconds) as response:
            return response.read()
