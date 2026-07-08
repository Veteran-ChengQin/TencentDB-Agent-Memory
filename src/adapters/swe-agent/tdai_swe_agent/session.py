from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any

from .config import SessionConfig


def default_run_id(output_dir: Path | None = None) -> str:
    if output_dir is not None:
        name = output_dir.name
        if name and name != ".":
            return _slug(name)
    return time.strftime("%Y%m%d-%H%M%S")


def make_session_key(config: SessionConfig, instance: Any, *, run_id: str) -> str:
    instance_id = _instance_id(instance)
    repo_name = _repo_name(instance)
    if config.scope == "custom":
        if not config.custom_session_key:
            raise ValueError("session.custom_session_key is required when scope=custom")
        return config.custom_session_key
    if config.scope == "batch":
        return f"swe-agent/{_slug(run_id)}"
    if config.scope == "per_instance":
        return f"swe-agent/{_slug(run_id)}/{_slug(instance_id)}"
    if config.scope == "repo":
        return f"swe-agent/repo/{_slug(repo_name)}"
    raise ValueError(f"Unsupported session scope: {config.scope}")


def make_session_id(instance: Any, *, run_id: str) -> str:
    return f"{_slug(run_id)}:{_slug(_instance_id(instance))}"


def _instance_id(instance: Any) -> str:
    try:
        return str(instance.problem_statement.id)
    except Exception:
        return "unknown-instance"


def _repo_name(instance: Any) -> str:
    try:
        repo = instance.env.repo
        for attr in ("repo_name", "path", "github_url"):
            value = getattr(repo, attr, None)
            if value:
                return str(value)
    except Exception:
        pass
    return "unknown-repo"


def _slug(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip())
    return value.strip("-") or "default"
