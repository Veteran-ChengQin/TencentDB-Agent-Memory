from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from .config import SessionConfig
from .utils import slug


def default_run_id(output_dir: Path | None = None) -> str:
    if output_dir is not None and output_dir.name and output_dir.name != ".":
        return slug(output_dir.name)
    return time.strftime("%Y%m%d-%H%M%S")


def make_session_key(config: SessionConfig, task: Any, *, run_id: str) -> str:
    instance_id = slug(str(getattr(task, "instance_id", None) or "unknown-instance"))
    repo = slug(str(getattr(task, "repo", None) or "unknown-repo"))
    if config.scope == "custom":
        if not config.custom_session_key:
            raise ValueError("session.custom_session_key is required when scope=custom")
        return config.custom_session_key
    if config.scope == "batch":
        return f"openhands/{slug(run_id)}"
    if config.scope == "per_instance":
        return f"openhands/{slug(run_id)}/{instance_id}"
    if config.scope == "repo":
        return f"openhands/repo/{repo}"
    raise ValueError(f"Unsupported session scope: {config.scope}")


def make_session_id(task: Any, *, run_id: str) -> str:
    instance_id = slug(str(getattr(task, "instance_id", None) or "unknown-instance"))
    return f"{slug(run_id)}:{instance_id}"
