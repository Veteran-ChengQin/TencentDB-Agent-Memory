from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .audit import AuditLogger
from .capture import capture_openhands_run, read_optional_json, read_optional_text
from .client import OpenHandsApiClient, TdaiGatewayClient
from .config import TdaiOpenHandsConfig, load_config
from .events import load_events_from_path
from .prompt import (
    OpenHandsTask,
    build_recall_query,
    compose_recall_context,
    inject_recall_into_request,
    inject_tdai_mcp_config,
)
from .session import default_run_id, make_session_id, make_session_key
from .utils import json_safe


def run_from_cli(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    config = load_config(args.tdai_config)
    if args.command == "recall":
        return _cmd_recall(args, config)
    if args.command == "prepare-request":
        return _cmd_prepare_request(args, config)
    if args.command == "capture":
        return _cmd_capture(args, config)
    if args.command == "download":
        return _cmd_download(args, config)
    parser.error(f"unsupported command: {args.command}")
    return 2


def _cmd_recall(args: argparse.Namespace, config: TdaiOpenHandsConfig) -> int:
    task = _task_from_args(args)
    run_id = args.tdai_run_id or config.session.run_id or default_run_id(_optional_path(args.output_dir))
    session_key = args.session_key or make_session_key(config.session, task, run_id=run_id)
    audit = _audit(args, config)
    context, payload = _recall_context(config=config, task=task, session_key=session_key, audit=audit)
    output = {
        "instance_id": task.instance_id,
        "session_key": session_key,
        "session_id": make_session_id(task, run_id=run_id),
        "run_id": run_id,
        "context": context,
        "payload": payload,
    }
    _write_or_print(args.output, context if args.text_only else output)
    return 0


def _cmd_prepare_request(args: argparse.Namespace, config: TdaiOpenHandsConfig) -> int:
    task = _task_from_args(args)
    request_payload = json.loads(Path(args.request_file).read_text(encoding="utf-8-sig"))
    run_id = args.tdai_run_id or config.session.run_id or default_run_id(_optional_path(args.output_dir))
    session_key = args.session_key or make_session_key(config.session, task, run_id=run_id)
    audit = _audit(args, config)
    context, recall_payload = _recall_context(config=config, task=task, session_key=session_key, audit=audit)
    injected = inject_recall_into_request(request_payload, context, config=config.recall)
    injected = inject_tdai_mcp_config(injected, gateway=config.gateway, tools=config.tools)
    injected.setdefault("tags", {})
    if isinstance(injected["tags"], dict):
        injected["tags"]["tdai"] = "enabled"
        injected["tags"]["tdairun"] = run_id[:64]
    output = {
        "request": injected,
        "tdai": {
            "instance_id": task.instance_id,
            "session_key": session_key,
            "session_id": make_session_id(task, run_id=run_id),
            "run_id": run_id,
            "recall": recall_payload,
        },
    }
    _write_or_print(args.output, output)
    return 0


def _cmd_capture(args: argparse.Namespace, config: TdaiOpenHandsConfig) -> int:
    if not config.capture.enabled:
        return 0
    task = _task_from_args(args)
    run_id = args.tdai_run_id or config.session.run_id or default_run_id(_optional_path(args.output_dir))
    session_key = args.session_key or make_session_key(config.session, task, run_id=run_id)
    session_id = args.session_id or make_session_id(task, run_id=run_id)
    audit = _audit(args, config)
    events: list[dict[str, Any]] = []
    for event_path in args.events_file or []:
        events.extend(load_events_from_path(event_path))
    trajectory = read_optional_json(args.trajectory_file)
    patch = read_optional_text(args.patch_file)
    metadata = read_optional_json(args.metadata_file) or {}
    metadata.update(
        {
            "platform": "openhands",
            "instance_id": task.instance_id,
            "repo": task.repo,
            "base_commit": task.base_commit,
        }
    )
    client = TdaiGatewayClient(config.gateway)
    result = capture_openhands_run(
        client=client,
        task=task,
        session_key=session_key,
        session_id=session_id,
        user_id=config.session.user_id,
        config=config.capture,
        events=events,
        trajectory=trajectory,
        patch=patch,
        metadata=metadata,
        audit=audit,
    )
    _write_or_print(args.output, result.raw)
    return 0


def _cmd_download(args: argparse.Namespace, config: TdaiOpenHandsConfig) -> int:
    client = OpenHandsApiClient(config.openhands)
    data = client.download_conversation(args.conversation_id)
    Path(args.output).write_bytes(data)
    return 0


def _recall_context(
    *,
    config: TdaiOpenHandsConfig,
    task: OpenHandsTask,
    session_key: str,
    audit: AuditLogger | None,
) -> tuple[str, dict[str, Any]]:
    if not config.enabled or not config.recall.enabled:
        return "", {"enabled": False}
    client = TdaiGatewayClient(config.gateway)
    query = build_recall_query(task)
    recall = None
    l1_search = None
    if config.recall.include_gateway_recall:
        recall = client.recall(query=query, session_key=session_key, user_id=config.session.user_id)
    if config.recall.include_l1_search:
        l1_search = client.search_memories(query=query, limit=config.recall.l1_search_limit)
    context = compose_recall_context(
        recall=recall,
        l1_search=l1_search,
        config=config.recall,
        tool_bundle_enabled=config.tools.enabled,
    )
    payload = {
        "query": query,
        "session_key": session_key,
        "recall": recall.raw if recall else None,
        "l1_search": l1_search.raw if l1_search else None,
        "context_chars": len(context),
    }
    if audit:
        audit.event(
            "recall",
            {
                "instance_id": task.instance_id,
                "session_key": session_key,
                "context_chars": len(context),
                "recall_error": recall.raw.get("_tdai_error") if recall else None,
                "l1_error": l1_search.raw.get("_tdai_error") if l1_search else None,
            },
        )
        audit.recall_payload(payload)
    return context, payload


def _task_from_args(args: argparse.Namespace) -> OpenHandsTask:
    problem_statement = args.problem_text
    if args.problem_file:
        problem_statement = Path(args.problem_file).read_text(encoding="utf-8-sig", errors="replace")
    if not problem_statement:
        raise SystemExit("--problem-file or --problem-text is required")
    return OpenHandsTask(
        instance_id=args.instance_id,
        repo=args.repo,
        base_commit=args.base_commit,
        problem_statement=problem_statement,
    )


def _audit(args: argparse.Namespace, config: TdaiOpenHandsConfig) -> AuditLogger | None:
    audit_dir = args.audit_dir
    if not audit_dir and args.output_dir:
        audit_dir = str(Path(args.output_dir) / config.logs.dir)
    if not audit_dir:
        return None
    return AuditLogger(
        Path(audit_dir),
        save_recall_payloads=config.logs.save_recall_payloads,
        save_capture_payloads=config.logs.save_capture_payloads,
    )


def _write_or_print(output_path: str | None, value: Any) -> None:
    if output_path:
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(value, str):
            path.write_text(value, encoding="utf-8")
        else:
            path.write_text(json.dumps(json_safe(value), ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
        return
    if isinstance(value, str):
        print(value)
    else:
        print(json.dumps(json_safe(value), ensure_ascii=False, indent=2, sort_keys=True))


def _optional_path(value: str | None) -> Path | None:
    return Path(value) if value else None


def _add_common_task_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--instance-id", required=True)
    parser.add_argument("--repo")
    parser.add_argument("--base-commit")
    parser.add_argument("--problem-file")
    parser.add_argument("--problem-text")
    parser.add_argument("--tdai-run-id")
    parser.add_argument("--session-key")
    parser.add_argument("--output-dir")
    parser.add_argument("--audit-dir")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OpenHands adapter for TencentDB Agent Memory.")
    parser.add_argument("--tdai-config", help="Path to a JSON/YAML TDAI OpenHands adapter config.")
    sub = parser.add_subparsers(dest="command", required=True)

    recall = sub.add_parser("recall", help="Generate a TDAI recall context block for an OpenHands task.")
    _add_common_task_args(recall)
    recall.add_argument("--output")
    recall.add_argument("--text-only", action="store_true")

    prepare = sub.add_parser("prepare-request", help="Inject TDAI recall into an OpenHands start request JSON.")
    _add_common_task_args(prepare)
    prepare.add_argument("--request-file", required=True)
    prepare.add_argument("--output")

    capture = sub.add_parser("capture", help="Capture an OpenHands run into TDAI memory.")
    _add_common_task_args(capture)
    capture.add_argument("--session-id")
    capture.add_argument("--events-file", action="append")
    capture.add_argument("--trajectory-file")
    capture.add_argument("--patch-file")
    capture.add_argument("--metadata-file")
    capture.add_argument("--output")

    download = sub.add_parser("download", help="Download an OpenHands conversation export zip.")
    download.add_argument("--conversation-id", required=True)
    download.add_argument("--output", required=True)
    return parser


if __name__ == "__main__":
    sys.exit(run_from_cli())
