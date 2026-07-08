from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field, fields, is_dataclass
from pathlib import Path
from typing import Any, Literal, TypeVar


@dataclass
class GatewayConfig:
    url: str = "http://127.0.0.1:8420"
    api_key: str | None = None
    api_key_env: str = "TDAI_GATEWAY_API_KEY"
    timeout_seconds: float = 8.0
    fail_open: bool = True

    def resolved_api_key(self) -> str | None:
        if self.api_key:
            return self.api_key
        return os.getenv(self.api_key_env) or None


@dataclass
class SessionConfig:
    scope: Literal["batch", "per_instance", "repo", "custom"] = "per_instance"
    run_id: str | None = None
    user_id: str = "openhands"
    custom_session_key: str | None = None


@dataclass
class RecallConfig:
    enabled: bool = True
    include_gateway_recall: bool = True
    include_l1_search: bool = True
    l1_search_limit: int = 5
    max_context_chars: int = 6000
    inject_position: Literal["before_task", "after_task"] = "before_task"
    strip_tool_guide_if_no_tool_bundle: bool = True


@dataclass
class CaptureConfig:
    enabled: bool = True
    include_events: bool = True
    include_patch: bool = True
    include_messages: bool = True
    max_assistant_summary_chars: int = 5000
    max_patch_chars: int = 12000
    session_end_after_capture: bool = False


@dataclass
class ToolConfig:
    enabled: bool = False
    server_name: str = "tdai_search"
    command: str | None = None
    server_script: str | None = None
    gateway_url: str | None = None
    api_key_env: str = "TDAI_GATEWAY_API_KEY"
    memory_search_limit: int = 5
    conversation_search_limit: int = 5


@dataclass
class LogsConfig:
    dir: str = "tdai"
    save_recall_payloads: bool = True
    save_capture_payloads: bool = True


@dataclass
class OpenHandsApiConfig:
    app_server_url: str | None = None
    agent_server_url: str | None = None
    session_api_key: str | None = None
    session_api_key_env: str = "OPENHANDS_SESSION_API_KEY"
    timeout_seconds: float = 30.0

    def resolved_session_api_key(self) -> str | None:
        if self.session_api_key:
            return self.session_api_key
        return os.getenv(self.session_api_key_env) or None


@dataclass
class TdaiOpenHandsConfig:
    enabled: bool = True
    gateway: GatewayConfig = field(default_factory=GatewayConfig)
    session: SessionConfig = field(default_factory=SessionConfig)
    recall: RecallConfig = field(default_factory=RecallConfig)
    capture: CaptureConfig = field(default_factory=CaptureConfig)
    tools: ToolConfig = field(default_factory=ToolConfig)
    logs: LogsConfig = field(default_factory=LogsConfig)
    openhands: OpenHandsApiConfig = field(default_factory=OpenHandsApiConfig)

    def to_dict(self, *, redact: bool = False) -> dict[str, Any]:
        data = asdict(self)
        if redact:
            if data.get("gateway", {}).get("api_key"):
                data["gateway"]["api_key"] = "<redacted>"
            if data.get("openhands", {}).get("session_api_key"):
                data["openhands"]["session_api_key"] = "<redacted>"
        return data


T = TypeVar("T")


def load_config(path: str | Path | None = None) -> TdaiOpenHandsConfig:
    if path is None:
        return TdaiOpenHandsConfig()
    config_path = Path(path)
    raw = config_path.read_text(encoding="utf-8")
    if config_path.suffix.lower() == ".json":
        data = json.loads(raw)
    else:
        try:
            import yaml  # type: ignore
        except ImportError as exc:
            raise RuntimeError("PyYAML is required to load YAML TDAI config files") from exc
        data = yaml.safe_load(raw) or {}
    return config_from_mapping(data)


def config_from_mapping(data: dict[str, Any] | None) -> TdaiOpenHandsConfig:
    data = data or {}
    return TdaiOpenHandsConfig(
        enabled=bool(data.get("enabled", True)),
        gateway=_dataclass_from_mapping(GatewayConfig, data.get("gateway", {})),
        session=_dataclass_from_mapping(SessionConfig, data.get("session", {})),
        recall=_dataclass_from_mapping(RecallConfig, data.get("recall", {})),
        capture=_dataclass_from_mapping(CaptureConfig, data.get("capture", {})),
        tools=_dataclass_from_mapping(ToolConfig, data.get("tools", {})),
        logs=_dataclass_from_mapping(LogsConfig, data.get("logs", {})),
        openhands=_dataclass_from_mapping(OpenHandsApiConfig, data.get("openhands", {})),
    )


def _dataclass_from_mapping(cls: type[T], data: dict[str, Any] | None) -> T:
    if not is_dataclass(cls):
        raise TypeError(f"{cls!r} is not a dataclass")
    data = data or {}
    allowed = {f.name for f in fields(cls)}
    values = {key: value for key, value in data.items() if key in allowed}
    return cls(**values)  # type: ignore[misc]
