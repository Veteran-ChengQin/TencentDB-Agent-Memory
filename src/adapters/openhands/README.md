# TDAI Adapter for OpenHands

This directory contains an OpenHands adapter for TencentDB Agent Memory.

The adapter follows the rule used for the SWE-agent integration: it is platform
adapter code, not a patch to OpenHands core logic.

## What It Does

- Calls the TDAI Gateway `/recall` endpoint before an OpenHands task starts.
- Calls `/search/memories` from the adapter side to include L1 memories without
  changing the legacy `/recall.context` Gateway semantics.
- Produces a `<tdai_recall_context>` block that can be injected into an
  OpenHands initial message or start request JSON.
- Captures exported OpenHands events, trajectories, metadata, and patches
  through `/capture` after a run finishes.
- Optionally exposes active memory search through an MCP server.

## Layout

- `tdai_openhands/`: Python adapter package.
- `configs/tdai-longterm-only.yaml`: reference configuration.
- `configs/tdai-openhands-launcher.yaml`: one-command launcher configuration.
- `tools/tdai_search/`: optional MCP memory search tool.
- `tests/`: adapter unit tests.
- `run_with_tdai.py`: small CLI entrypoint.

## One-Command Launcher

For the common local workflow, edit:

```text
configs/tdai-openhands-launcher.yaml
```

Then run:

```bash
export PYTHONPATH="/path/to/TencentDB-Agent-Memory/src/adapters/openhands:$PYTHONPATH"
export TDAI_LLM_API_KEY="..."
python -m tdai_openhands.launcher \
  --launcher-config /path/to/TencentDB-Agent-Memory/src/adapters/openhands/configs/tdai-openhands-launcher.yaml \
  terminal
```

The launcher checks or starts the TDAI Gateway, injects configured software
engineering seed memories, and then enters the OpenHands terminal command. Set
`openhands.command` in the launcher config when your OpenHands installation does
not expose `openhands` or `openhands-cli` on `PATH`.

To seed memories only:

```bash
python -m tdai_openhands.launcher \
  --launcher-config /path/to/TencentDB-Agent-Memory/src/adapters/openhands/configs/tdai-openhands-launcher.yaml \
  seed
```

## Recall Only

Start the TDAI Gateway first:

```bash
node --import tsx src/gateway/server.ts
```

Then make the adapter importable:

```bash
export PYTHONPATH="/path/to/TencentDB-Agent-Memory/src/adapters/openhands:$PYTHONPATH"
```

Generate a recall block:

This command does **not** start OpenHands. It only talks to the TDAI Gateway and
writes a recall context block that your OpenHands runner, App Server request, or
manual task prompt can consume.

```bash
python -m tdai_openhands.runner \
  --tdai-config /path/to/TencentDB-Agent-Memory/src/adapters/openhands/configs/tdai-longterm-only.yaml \
  recall \
  --instance-id pylint-dev__pylint-4551 \
  --repo pylint-dev/pylint \
  --base-commit <base_commit> \
  --problem-file /path/to/problem_statement.txt \
  --tdai-run-id openhands-tdai-smoke \
  --text-only \
  --output /tmp/tdai_recall_context.txt
```

## Prepare an OpenHands Start Request

If you start OpenHands through the App Server API, prepare the request JSON
without modifying OpenHands:

```bash
python -m tdai_openhands.runner \
  --tdai-config /path/to/config.yaml \
  prepare-request \
  --request-file /tmp/openhands_start_request.json \
  --instance-id pylint-dev__pylint-4551 \
  --repo pylint-dev/pylint \
  --problem-file /tmp/problem_statement.txt \
  --tdai-run-id openhands-tdai-smoke \
  --output /tmp/openhands_start_request.tdai.json
```

The output contains:

- `request`: the OpenHands request with TDAI context injected into
  `initial_message`.
- `tdai`: session key, session id, run id, and recall payload metadata.

## Capture an OpenHands Run

After OpenHands finishes, capture exported events/trajectory/patch:

```bash
python -m tdai_openhands.runner \
  --tdai-config /path/to/config.yaml \
  capture \
  --instance-id pylint-dev__pylint-4551 \
  --repo pylint-dev/pylint \
  --base-commit <base_commit> \
  --problem-file /tmp/problem_statement.txt \
  --events-file /tmp/openhands_events.json \
  --trajectory-file /tmp/openhands_trajectory.json \
  --patch-file /tmp/patch.diff \
  --tdai-run-id openhands-tdai-smoke \
  --output /tmp/tdai_capture_response.json
```

`--events-file` may be repeated. It accepts JSON, JSONL, or an OpenHands
conversation export zip when the archive contains event/trajectory/history JSON
files.

## Optional Active Search Tool

The `tools/tdai_search/tdai_mcp_server.py` file exposes:

- `tdai_memory_search`
- `tdai_conversation_search`

Register it with OpenHands as a custom MCP server when active in-run memory
search is needed. Keep it disabled for recall-only experiments.

## Design Boundaries

- Does not modify OpenHands source code.
- Does not modify TDAI core recall/capture/search behavior.
- Does not change the Gateway `/recall.context` response semantics.
- Does not take over OpenHands context management or compaction.
