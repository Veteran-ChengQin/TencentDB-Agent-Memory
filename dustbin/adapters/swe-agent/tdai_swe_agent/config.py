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
    scope: Literal["batch", "per_instance", "repo", "custom"] = "batch"
    run_id: str | None = None
    user_id: str = "swe-agent"
    custom_session_key: str | None = None


@dataclass
class RecallConfig:
    enabled: bool = True
    mode: Literal["once_per_instance", "each_query"] = "once_per_instance"
    max_context_chars: int = 6000
    inject_position: Literal["after_instance_prompt"] = "after_instance_prompt"
    strip_tool_guide_if_no_tool_bundle: bool = True
    include_l1_search: bool = True
    l1_search_limit: int = 5


@dataclass
class ToolBundleConfig:
    enabled: bool = False
    path: str | None = None
    gateway_url: str | None = None
    api_key_env: str = "TDAI_GATEWAY_API_KEY"
    propagate_api_key_env: bool = True
    memory_search_limit: int = 5
    conversation_search_limit: int = 5


@dataclass
class CaptureConfig:
    enabled: bool = True
    when: Literal["run_done"] = "run_done"
    include_raw_history: bool = True
    include_trajectory_summary: bool = True
    max_assistant_summary_chars: int = 4000
    session_end_after_instance: bool = False


@dataclass
class LogsConfig:
    dir: str = "tdai"
    save_recall_payloads: bool = True
    save_capture_payloads: bool = True


@dataclass
class TdaiSweAgentConfig:
    enabled: bool = True
    gateway: GatewayConfig = field(default_factory=GatewayConfig)
    session: SessionConfig = field(default_factory=SessionConfig)
    recall: RecallConfig = field(default_factory=RecallConfig)
    tools: ToolBundleConfig = field(default_factory=ToolBundleConfig)
    capture: CaptureConfig = field(default_factory=CaptureConfig)
    logs: LogsConfig = field(default_factory=LogsConfig)

    def to_dict(self, *, redact: bool = False) -> dict[str, Any]:
        data = asdict(self)
        if redact and data.get("gateway", {}).get("api_key"):
            data["gateway"]["api_key"] = "<redacted>"
        return data


T = TypeVar("T")


def load_config(path: str | Path | None = None) -> TdaiSweAgentConfig:
    if path is None:
        return TdaiSweAgentConfig()
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


def config_from_mapping(data: dict[str, Any] | None) -> TdaiSweAgentConfig:
    data = data or {}
    return TdaiSweAgentConfig(
        enabled=bool(data.get("enabled", True)),
        gateway=_dataclass_from_mapping(GatewayConfig, data.get("gateway", {})),
        session=_dataclass_from_mapping(SessionConfig, data.get("session", {})),
        recall=_dataclass_from_mapping(RecallConfig, data.get("recall", {})),
        tools=_dataclass_from_mapping(ToolBundleConfig, data.get("tools", {})),
        capture=_dataclass_from_mapping(CaptureConfig, data.get("capture", {})),
        logs=_dataclass_from_mapping(LogsConfig, data.get("logs", {})),
    )


def _dataclass_from_mapping(cls: type[T], data: dict[str, Any] | None) -> T:
    if not is_dataclass(cls):
        raise TypeError(f"{cls!r} is not a dataclass")
    data = data or {}
    allowed = {f.name for f in fields(cls)}
    values = {key: value for key, value in data.items() if key in allowed}
    return cls(**values)  # type: ignore[misc]
