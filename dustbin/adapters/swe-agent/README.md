# TDAI Adapter for SWE-agent

This directory contains a SWE-agent adapter for TencentDB Agent Memory.
It is intentionally implemented as an adapter layer instead of a patch to
SWE-agent core code.

## What It Does

- Calls the TDAI Gateway `/recall` endpoint before a SWE-bench instance starts.
- Calls `/search/memories` from the adapter side to inject L1 relevant memories
  without changing the legacy `/recall.context` Gateway semantics.
- Injects the combined memory context through a SWE-agent history processor.
- Captures the cleaned run history through `/capture` when an instance finishes.
- Optionally exposes active search commands as a SWE-agent tool bundle.

## Layout

- `tdai_swe_agent/`: Python adapter package.
- `configs/tdai-longterm-only.yaml`: reference configuration.
- `configs/tdai-sweagent-launcher.yaml`: one-command launcher configuration.
- `tools/tdai_search/`: optional SWE-agent tool bundle for active memory search.
- `tests/`: adapter unit tests.
- `run_with_tdai.py`: small CLI entrypoint.

## One-Command Launcher

For the common local SWE-bench workflow, edit:

```text
configs/tdai-sweagent-launcher.yaml
```

Then run:

```bash
export PYTHONPATH="/path/to/TencentDB-Agent-Memory/src/adapters/swe-agent:/path/to/SWE-agent:$PYTHONPATH"
export TDAI_LLM_API_KEY="..."
python -m tdai_swe_agent.launcher \
  --launcher-config /path/to/TencentDB-Agent-Memory/src/adapters/swe-agent/configs/tdai-sweagent-launcher.yaml \
  run
```

The launcher checks or starts the TDAI Gateway, injects configured software
engineering seed memories, and then calls the existing `tdai_swe_agent.runner`
with `swe_agent.args` from the launcher config. Extra SWE-agent args can be
appended after `--`.

To seed memories only:

```bash
python -m tdai_swe_agent.launcher \
  --launcher-config /path/to/TencentDB-Agent-Memory/src/adapters/swe-agent/configs/tdai-sweagent-launcher.yaml \
  seed
```

## Running

Start the TDAI Gateway first:

```bash
node --import tsx src/gateway/server.ts
```

Then make this adapter and SWE-agent importable:

```bash
export PYTHONPATH="/path/to/TencentDB-Agent-Memory/src/adapters/swe-agent:/path/to/SWE-agent:$PYTHONPATH"
```

Run SWE-agent through the adapter:

```bash
python -m tdai_swe_agent.runner \
  --tdai-config /path/to/TencentDB-Agent-Memory/src/adapters/swe-agent/configs/tdai-longterm-only.yaml \
  --tdai-run-id swebench-verified-tdai-test \
  --instances.type swe_bench \
  --instances.subset verified \
  --instances.split test \
  --instances.filter 'pylint-dev__pylint-4551' \
  --agent.model.name gpt-4o \
  --config /path/to/SWE-agent/config/default.yaml
```

The `--tdai-*` options are consumed by the adapter; all other arguments are
forwarded to SWE-agent's `RunBatchConfig` CLI.

## Recall Behavior

The Gateway `/recall.context` field is treated as the legacy stable context
channel, usually containing persona, scene navigation, and memory tool guidance.
The adapter separately calls `/search/memories` to retrieve L1 relevant memories
and prepends them as:

```xml
<relevant-memories>
...
</relevant-memories>
```

This keeps existing Gateway clients compatible while still giving SWE-agent
access to L1/L2/L3 memory.

## Optional Active Search Tools

Set `tools.enabled: true` in the TDAI config to add the `tdai_search` SWE-agent
tool bundle. It provides:

- `tdai_memory_search <query> [limit]`
- `tdai_conversation_search <query> [limit]`

The tools run inside the SWE-bench container and call the TDAI Gateway over
HTTP. For Docker-based SWE-bench runs, configure `tools.gateway_url` to a URL
reachable from inside the container, for example `http://host.docker.internal:8420`
on Docker Desktop when supported.

## Design Boundaries

- Does not modify SWE-agent source code.
- Does not modify TDAI core recall/capture/search behavior.
- Does not change the Gateway `/recall.context` response semantics.
- Does not take over SWE-agent short-context/windowing logic.
