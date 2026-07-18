from __future__ import annotations

import sys
import threading
import traceback
import json
from pathlib import Path
from typing import Any, Self

import yaml

from .audit import AuditLogger
from .capture_hook import TdaiCaptureHook
from .client import TdaiGatewayClient
from .config import TdaiSweAgentConfig, load_config
from .history_processor import TdaiRecallHistoryProcessor, insert_recall_processor
from .session import default_run_id, make_session_id, make_session_key


def _import_sweagent_runtime() -> dict[str, Any]:
    from sweagent.agent.agents import get_agent_from_config
    from sweagent.agent.hooks.status import SetStatusAgentHook
    from sweagent.environment.hooks.status import SetStatusEnvironmentHook
    from sweagent.environment.swe_env import SWEEnv
    from sweagent.run.batch_instances import SWEBenchInstances
    from sweagent.run.common import BasicCLI, ConfigHelper, save_predictions
    from sweagent.run.run_batch import RunBatch, RunBatchConfig
    from sweagent.run.run_single import RunSingleConfig
    from swerex.deployment.hooks.status import SetStatusDeploymentHook

    return {
        "get_agent_from_config": get_agent_from_config,
        "SetStatusAgentHook": SetStatusAgentHook,
        "SetStatusEnvironmentHook": SetStatusEnvironmentHook,
        "SetStatusDeploymentHook": SetStatusDeploymentHook,
        "SWEEnv": SWEEnv,
        "SWEBenchInstances": SWEBenchInstances,
        "BasicCLI": BasicCLI,
        "ConfigHelper": ConfigHelper,
        "save_predictions": save_predictions,
        "RunBatch": RunBatch,
        "RunBatchConfig": RunBatchConfig,
        "RunSingleConfig": RunSingleConfig,
    }


class TdaiRunBatch:
    """RunBatch wrapper that injects TDAI hooks after agent construction."""

    def __init__(self, base_run_batch: Any, tdai_config: TdaiSweAgentConfig) -> None:
        self._base = base_run_batch
        self.tdai_config = tdai_config
        self.client = TdaiGatewayClient(tdai_config.gateway)
        self.run_id = tdai_config.session.run_id or default_run_id(base_run_batch.output_dir)
        self._known_sessions: set[str] = set()
        self._session_lock = threading.Lock()

    @classmethod
    def from_config(cls, config: Any, tdai_config: TdaiSweAgentConfig) -> Self:
        runtime = _import_sweagent_runtime()
        RunBatch = runtime["RunBatch"]
        SWEBenchInstances = runtime["SWEBenchInstances"]

        _enable_tdai_tool_bundle(config, tdai_config)
        base = RunBatch.from_config(config)
        wrapper = cls(base, tdai_config)
        if isinstance(config.instances, SWEBenchInstances) and config.instances.evaluate:
            # RunBatch.from_config already installed the evaluation hook.
            pass
        config_path = Path(base.output_dir) / "tdai-adapter.config.json"
        config_path.write_text(
            json.dumps(tdai_config.to_dict(redact=True), ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        return wrapper

    def main(self) -> None:
        original = self._base._run_instance
        self._base._run_instance = self._run_instance_with_tdai  # type: ignore[method-assign]
        try:
            self._base.main()
        finally:
            self._base._run_instance = original  # type: ignore[method-assign]
            self._flush_batch_sessions()

    def _run_instance_with_tdai(self, instance: Any) -> Any:
        runtime = _import_sweagent_runtime()
        output_dir = Path(self._base.output_dir) / instance.problem_statement.id
        output_dir.mkdir(parents=True, exist_ok=True)

        self._base.agent_config.name = f"{instance.problem_statement.id}"
        agent = runtime["get_agent_from_config"](self._base.agent_config)
        single_run_replay_config = runtime["RunSingleConfig"](
            agent=self._base.agent_config,
            problem_statement=instance.problem_statement,
            env=instance.env,
        )
        (output_dir / f"{instance.problem_statement.id}.config.yaml").write_text(
            yaml.dump(single_run_replay_config.model_dump_json(), indent=2),
            encoding="utf-8",
        )
        agent.replay_config = single_run_replay_config

        if self.tdai_config.enabled:
            self._attach_tdai(agent=agent, instance=instance, output_dir=output_dir)

        agent.add_hook(
            runtime["SetStatusAgentHook"](
                instance.problem_statement.id,
                self._base._progress_manager.update_instance_status,
            )
        )
        self._base._progress_manager.update_instance_status(instance.problem_statement.id, "Starting environment")
        instance.env.name = f"{instance.problem_statement.id}"
        env = runtime["SWEEnv"].from_config(instance.env)
        env.add_hook(
            runtime["SetStatusEnvironmentHook"](
                instance.problem_statement.id,
                self._base._progress_manager.update_instance_status,
            )
        )
        env.deployment.add_hook(
            runtime["SetStatusDeploymentHook"](
                instance.problem_statement.id,
                self._base._progress_manager.update_instance_status,
            )
        )
        try:
            env.start()
            self._base._chooks.on_instance_start(index=0, env=env, problem_statement=instance.problem_statement)
            result = agent.run(
                problem_statement=instance.problem_statement,
                env=env,
                output_dir=output_dir,
            )
        except Exception:
            agent.logger.error(traceback.format_exc())
            raise
        finally:
            env.close()
        runtime["save_predictions"](self._base.output_dir, instance.problem_statement.id, result)
        self._base._chooks.on_instance_completed(result=result)
        return result

    def _attach_tdai(self, *, agent: Any, instance: Any, output_dir: Path) -> None:
        session_key = make_session_key(self.tdai_config.session, instance, run_id=self.run_id)
        session_id = make_session_id(instance, run_id=self.run_id)
        with self._session_lock:
            self._known_sessions.add(session_key)
        _set_tdai_tool_env(agent, self.tdai_config, session_key=session_key)
        audit_dir = output_dir / self.tdai_config.logs.dir
        audit = AuditLogger(
            audit_dir,
            save_recall_payloads=self.tdai_config.logs.save_recall_payloads,
            save_capture_payloads=self.tdai_config.logs.save_capture_payloads,
        )
        audit.event(
            "attach",
            {
                "instance_id": instance.problem_statement.id,
                "session_key": session_key,
                "session_id": session_id,
                "run_id": self.run_id,
            },
        )
        recall = TdaiRecallHistoryProcessor(
            client=self.client,
            config=self.tdai_config.recall,
            session_key=session_key,
            user_id=self.tdai_config.session.user_id,
            instance_id=instance.problem_statement.id,
            audit=audit,
        )
        insert_recall_processor(agent, recall)
        capture = TdaiCaptureHook(
            client=self.client,
            config=self.tdai_config.capture,
            session_key=session_key,
            session_id=session_id,
            user_id=self.tdai_config.session.user_id,
            instance_id=instance.problem_statement.id,
            audit=audit,
        )
        agent.add_hook(capture)

    def _flush_batch_sessions(self) -> None:
        if self.tdai_config.capture.session_end_after_instance:
            return
        if self.tdai_config.session.scope not in {"batch", "custom"}:
            return
        for session_key in sorted(self._known_sessions):
            try:
                self.client.session_end(session_key=session_key, user_id=self.tdai_config.session.user_id)
            except Exception:
                if not self.tdai_config.gateway.fail_open:
                    raise


def _split_tdai_args(args: list[str]) -> tuple[str | None, dict[str, str], list[str]]:
    tdai_config_path: str | None = None
    overrides: dict[str, str] = {}
    remaining: list[str] = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--tdai-config":
            tdai_config_path = args[i + 1]
            i += 2
        elif arg.startswith("--tdai-config="):
            tdai_config_path = arg.split("=", 1)[1]
            i += 1
        elif arg in {"--tdai-run-id", "--tdai-gateway-url", "--tdai-session-scope"}:
            overrides[arg[2:].replace("tdai-", "").replace("-", "_")] = args[i + 1]
            i += 2
        elif any(arg.startswith(prefix) for prefix in ("--tdai-run-id=", "--tdai-gateway-url=", "--tdai-session-scope=")):
            key, value = arg[2:].split("=", 1)
            overrides[key.replace("tdai-", "").replace("-", "_")] = value
            i += 1
        elif arg == "--tdai-disable":
            overrides["enabled"] = "false"
            i += 1
        else:
            remaining.append(arg)
            i += 1
    return tdai_config_path, overrides, remaining


def _apply_overrides(config: TdaiSweAgentConfig, overrides: dict[str, str]) -> TdaiSweAgentConfig:
    if overrides.get("enabled") == "false":
        config.enabled = False
    if "run_id" in overrides:
        config.session.run_id = overrides["run_id"]
    if "gateway_url" in overrides:
        config.gateway.url = overrides["gateway_url"]
    if "session_scope" in overrides:
        config.session.scope = overrides["session_scope"]  # type: ignore[assignment]
    return config


def run_from_config(config: Any, tdai_config: TdaiSweAgentConfig) -> None:
    TdaiRunBatch.from_config(config, tdai_config).main()


def run_from_cli(args: list[str] | None = None) -> None:
    if args is None:
        args = sys.argv[1:]
    tdai_config_path, overrides, sweagent_args = _split_tdai_args(args)
    tdai_config = _apply_overrides(load_config(tdai_config_path), overrides)

    runtime = _import_sweagent_runtime()
    RunBatchConfig = runtime["RunBatchConfig"]
    BasicCLI = runtime["BasicCLI"]
    ConfigHelper = runtime["ConfigHelper"]

    help_text = (
        "Run SWE-agent with TencentDB Agent Memory long-term recall/capture.\n\n"
        "TDAI options: --tdai-config, --tdai-run-id, --tdai-gateway-url, "
        "--tdai-session-scope, --tdai-disable\n\n"
        + ConfigHelper().get_help(RunBatchConfig)
    )
    config = BasicCLI(RunBatchConfig, help_text=help_text).get_config(sweagent_args)
    run_from_config(config, tdai_config)


def _enable_tdai_tool_bundle(config: Any, tdai_config: TdaiSweAgentConfig) -> None:
    if not tdai_config.enabled or not tdai_config.tools.enabled:
        return
    from sweagent.tools.bundle import Bundle

    tools_config = getattr(config.agent, "tools", None)
    if tools_config is None:
        return
    bundle_path = Path(tdai_config.tools.path) if tdai_config.tools.path else _default_tool_bundle_path()
    bundle = Bundle(path=bundle_path)
    existing_paths = {Path(existing.path).resolve() for existing in tools_config.bundles}
    if bundle.path.resolve() not in existing_paths:
        tools_config.bundles.append(bundle)

    env = dict(tools_config.env_variables)
    env["TDAI_GATEWAY_URL"] = tdai_config.tools.gateway_url or tdai_config.gateway.url
    env["TDAI_GATEWAY_API_KEY_ENV"] = tdai_config.tools.api_key_env
    env["TDAI_GATEWAY_TIMEOUT"] = str(tdai_config.gateway.timeout_seconds)
    env["TDAI_MEMORY_SEARCH_LIMIT"] = str(tdai_config.tools.memory_search_limit)
    env["TDAI_CONVERSATION_SEARCH_LIMIT"] = str(tdai_config.tools.conversation_search_limit)
    tools_config.env_variables = env

    if tdai_config.tools.propagate_api_key_env:
        propagated = list(tools_config.propagate_env_variables)
        if tdai_config.tools.api_key_env not in propagated:
            propagated.append(tdai_config.tools.api_key_env)
        tools_config.propagate_env_variables = propagated
    _refresh_tool_config_cache(tools_config)


def _set_tdai_tool_env(agent: Any, tdai_config: TdaiSweAgentConfig, *, session_key: str) -> None:
    if not tdai_config.enabled or not tdai_config.tools.enabled:
        return
    env = dict(agent.tools.config.env_variables)
    env["TDAI_SESSION_KEY"] = session_key
    agent.tools.config.env_variables = env


def _default_tool_bundle_path() -> Path:
    return Path(__file__).resolve().parents[1] / "tools" / "tdai_search"


def _refresh_tool_config_cache(tools_config: Any) -> None:
    for attr in ("commands", "tools", "state_commands", "use_function_calling"):
        tools_config.__dict__.pop(attr, None)
    tools_config.model_post_init(None)


if __name__ == "__main__":
    run_from_cli()
