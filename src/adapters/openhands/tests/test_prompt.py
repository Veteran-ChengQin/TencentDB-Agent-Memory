from tdai_openhands.client import MemorySearchResult, RecallResult
from tdai_openhands.config import RecallConfig
from tdai_openhands.config import GatewayConfig, ToolConfig
from tdai_openhands.prompt import (
    OpenHandsTask,
    build_recall_query,
    compose_recall_context,
    inject_tdai_mcp_config,
    inject_recall_into_request,
)


def test_build_recall_query_contains_swebench_fields() -> None:
    task = OpenHandsTask(
        instance_id="pylint-dev__pylint-4551",
        repo="pylint-dev/pylint",
        base_commit="abc123",
        problem_statement="Fix checker option handling.",
    )
    query = build_recall_query(task)
    assert "Platform: OpenHands" in query
    assert "pylint-dev__pylint-4551" in query
    assert "Fix checker option handling." in query


def test_compose_recall_context_combines_l1_and_recall() -> None:
    context = compose_recall_context(
        recall=RecallResult(context="scene memory"),
        l1_search=MemorySearchResult(results="l1 memory", total=1),
        config=RecallConfig(max_context_chars=2000),
    )
    assert "<tdai_recall_context>" in context
    assert "<relevant-memories>" in context
    assert "l1 memory" in context
    assert "scene memory" in context


def test_inject_recall_into_request_list_content() -> None:
    request = {
        "initial_message": {
            "role": "user",
            "content": [{"type": "text", "text": "Original task"}],
            "run": True,
        }
    }
    injected = inject_recall_into_request(request, "<tdai>memory</tdai>", config=RecallConfig())
    content = injected["initial_message"]["content"][0]["text"]
    assert "<tdai>memory</tdai>" in content
    assert "Original task" in content


def test_inject_tdai_mcp_config_is_opt_in() -> None:
    request = {"agent": {"mcp_config": {"mcpServers": {"existing": {"command": "x"}}}}}
    injected = inject_tdai_mcp_config(
        request,
        gateway=GatewayConfig(url="http://127.0.0.1:8420"),
        tools=ToolConfig(enabled=False),
    )
    assert injected == request


def test_inject_tdai_mcp_config_adds_search_server_without_overwriting_existing() -> None:
    request = {"agent": {"mcp_config": {"mcpServers": {"existing": {"command": "x"}}}}}
    injected = inject_tdai_mcp_config(
        request,
        gateway=GatewayConfig(url="http://127.0.0.1:8420"),
        tools=ToolConfig(enabled=True, command="python", memory_search_limit=2),
    )
    servers = injected["agent"]["mcp_config"]["mcpServers"]
    assert servers["existing"]["command"] == "x"
    assert servers["tdai_search"]["command"] == "python"
    assert servers["tdai_search"]["env"]["TDAI_GATEWAY_URL"] == "http://127.0.0.1:8420"
    assert servers["tdai_search"]["env"]["TDAI_MEMORY_SEARCH_LIMIT"] == "2"
    assert servers["tdai_search"]["args"][0].endswith("tdai_mcp_server.py")


def test_inject_tdai_mcp_config_leaves_app_server_payload_shape_unchanged() -> None:
    request = {"llm_model": "deepseek-v4-flash", "initial_message": {"content": "task"}}
    injected = inject_tdai_mcp_config(
        request,
        gateway=GatewayConfig(url="http://127.0.0.1:8420"),
        tools=ToolConfig(enabled=True),
    )
    assert injected == request
