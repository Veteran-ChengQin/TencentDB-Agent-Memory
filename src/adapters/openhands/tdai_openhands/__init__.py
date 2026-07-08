"""TencentDB Agent Memory adapter for OpenHands."""

from .capture import build_capture_payload, capture_openhands_run
from .client import CaptureResult, MemorySearchResult, RecallResult, TdaiGatewayClient
from .config import TdaiOpenHandsConfig, load_config
from .prompt import OpenHandsTask, build_recall_query, compose_recall_context, inject_recall_into_request
from .session import make_session_id, make_session_key

__all__ = [
    "CaptureResult",
    "MemorySearchResult",
    "OpenHandsTask",
    "RecallResult",
    "TdaiGatewayClient",
    "TdaiOpenHandsConfig",
    "build_capture_payload",
    "build_recall_query",
    "capture_openhands_run",
    "compose_recall_context",
    "inject_recall_into_request",
    "load_config",
    "make_session_id",
    "make_session_key",
]
