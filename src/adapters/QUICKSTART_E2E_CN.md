# OpenHands / SWE-agent + TDAI Quick Start 与 E2E 验证记录

本文记录如何从全新 clone 开始，配置 TencentDB Agent Memory（TDAI）平台适配器，注入软件工程经验 seed，并启动 OpenHands / SWE-agent 在真实 SWE-bench bug-fix 场景中读写记忆。

本适配遵循一个边界原则：不修改 OpenHands / SWE-agent 核心逻辑，只新增平台适配层和 launcher。TDAI 仍通过 Gateway 的 `/recall`、`/capture`、`/search/memories`、`/search/conversations` 提供能力。

## 1. 前置条件

建议环境：

- Node.js 22+。
- Python 3.10+。
- Docker 可用，并已能运行 SWE-bench instance image。
- 已安装并可运行目标平台：
  - OpenHands。
  - SWE-agent。
- 已准备模型供应商配置，并把 API key 放在环境变量中，不要写入 YAML。

以 SWE-bench Verified 的 `pylint-dev__pylint-4551` 为例，需要本地存在镜像：

```bash
docker image inspect swebench/sweb.eval.x86_64.pylint-dev_1776_pylint-4551:latest
```

## 2. Clone 与依赖安装

```bash
git clone \
  --branch feat/openhands-swe-agent-tdai-adapters \
  --single-branch \
  https://github.com/Veteran-ChengQin/TencentDB-Agent-Memory.git

cd TencentDB-Agent-Memory
npm install
```

如需在 Python 环境中调用 adapter，请按平台设置 `PYTHONPATH`：

OpenHands：

```bash
export PYTHONPATH="$PWD/src/adapters/openhands:$PYTHONPATH"
```

SWE-agent：

```bash
export PYTHONPATH="$PWD/src/adapters/swe-agent:/path/to/SWE-agent:$PYTHONPATH"
```

## 3. 启动 TDAI Gateway

最小配置示例：

```bash
export TDAI_DATA_DIR="$HOME/.tdai/swebench-memory"
export TDAI_LLM_MODEL="deepseek-v4-flash"
export TDAI_LLM_BASE_URL="https://api.deepseek.com"
export TDAI_LLM_API_KEY="<your-api-key>"

node --import tsx src/gateway/server.ts
```

健康检查：

```bash
curl http://127.0.0.1:8420/health
```

期望返回类似：

```json
{"status":"ok","version":"0.1.0","stores":{"vectorStore":true}}
```

## 4. 注入软件工程经验 seed

两个 launcher 都支持 `seed` 子命令。默认 `builtin: swe_bugfix` 会注入 5 条与 SWE-bench bug-fix 相关的软件工程经验，并调用 `/session/end` 触发后端抽取。

OpenHands：

```bash
python -m tdai_openhands.launcher \
  --launcher-config src/adapters/openhands/configs/tdai-openhands-launcher.yaml \
  seed
```

SWE-agent：

```bash
python -m tdai_swe_agent.launcher \
  --launcher-config src/adapters/swe-agent/configs/tdai-sweagent-launcher.yaml \
  seed
```

建议在配置中保留或设置：

```yaml
seed:
  enabled: true
  builtin: "swe_bugfix"
  session_end: true
  post_session_end_wait_seconds: 30
```

`post_session_end_wait_seconds` 用于给 L1/L2/L3 异步抽取留出时间。真实 agent 启动前等待一小段时间，更容易在第一轮任务里看到 recall 生效。

## 5. 启动 SWE-agent + TDAI

配置文件：

```text
src/adapters/swe-agent/configs/tdai-sweagent-launcher.yaml
```

典型命令：

```bash
python -m tdai_swe_agent.launcher \
  --launcher-config src/adapters/swe-agent/configs/tdai-sweagent-launcher.yaml \
  run
```

launcher 会完成：

1. 检查或启动 TDAI Gateway。
2. 注入 seed。
3. 调用 `tdai_swe_agent.runner`。
4. 在 SWE-agent 中通过 history processor 注入 TDAI recall context。
5. 在 run 结束后通过 capture hook 写回 trajectory、patch、metadata。

如果启用主动搜索工具，SWE-agent 可调用：

- `tdai_memory_search`
- `tdai_conversation_search`

注意：在一些 SWE-agent 版本中，从包含 `docker/` 子目录的仓库根目录启动可能触发路径归一化问题，把 `deployment.type: docker` 误处理成文件路径。遇到这种情况时，可以从独立 run 目录启动 launcher，并用绝对路径传入 launcher config。

## 6. 启动 OpenHands + TDAI

配置文件：

```text
src/adapters/openhands/configs/tdai-openhands-launcher.yaml
```

典型命令：

```bash
python -m tdai_openhands.launcher \
  --launcher-config src/adapters/openhands/configs/tdai-openhands-launcher.yaml \
  terminal
```

`openhands.command` 控制真正的 OpenHands 入口。如果 `openhands` / `openhands-cli` 不在 `PATH`，请显式配置：

```yaml
openhands:
  command:
    - "/path/to/python"
    - "-m"
    - "openhands.cli.main"
```

也可以把该命令配置为本地已有的 OpenHands SDK/SWE-bench runner。launcher 只负责 Gateway 检查、seed 注入和把控制权交给 OpenHands 入口，不要求改 OpenHands 源码。

OpenHands adapter 提供三类能力：

- 任务开始前调用 TDAI `/recall` 与 `/search/memories`，生成 `<tdai_recall_context>`。
- 可选 MCP tool server，暴露 `tdai_memory_search` 与 `tdai_conversation_search`。
- 任务结束后调用 `/capture`，把 events、trajectory、patch、metadata 写回 TDAI。

## 7. 真实 E2E 验证摘要

已用 `pylint-dev__pylint-4551` 做过真实 bug-fix 端到端验证：

### SWE-agent

- 从 fork clone 的 TDAI adapter 启动。
- 启动 TDAI Gateway。
- 注入 5 条 `swe_bugfix` seed。
- SWE-agent 真实启动 SWE-bench Docker testbed。
- TDAI recall 成功注入：
  - `injected_context` 约 5.7k chars。
  - 包含 L1 relevant memories 与 user persona。
- run 结束后 capture 成功：
  - `l0_recorded=127`。
- 生成 patch 与 `preds.json`。
- SWE-bench harness 成功完成：
  - `patch_successfully_applied=true`。
  - `resolved=false`。

### OpenHands

- 从 fork clone 的 TDAI adapter 启动 launcher。
- 显式配置 `openhands.command`，避免依赖 `openhands` 命令是否在 `PATH`。
- 注入 5 条 `swe_bugfix` seed。
- OpenHands 真实启动 agent，并挂载 SWE-bench Docker testbed。
- OpenHands MCP 初始化成功：
  - `tdai-openhands-search` 启动。
  - 加载 2 个 MCP tools。
- TDAI recall 成功注入：
  - recall context 达到配置上限 6000 chars。
  - 召回 5 条相关 L1 memories。
- run 结束后 capture 成功：
  - `l0_recorded=32`。
- 生成 patch、predictions 与 harness report。
- SWE-bench harness 成功完成：
  - `patch_successfully_applied=true`。
  - `resolved=false`。

这里的 `resolved=false` 说明模型给出的 patch 没有修复该 SWE-bench instance，但不影响适配器验证结论：TDAI 的 memory seed、recall、主动搜索工具加载、capture、patch 留档和 harness 评测链路均已在真实 bug-fix 场景中跑通。

## 8. 产物检查清单

运行后建议检查：

OpenHands：

```text
tdai/recall.json
tdai/capture_response.json
openhands_events.jsonl
patch.diff
predictions.json
logs/run_evaluation/**/report.json
```

SWE-agent：

```text
*/tdai/events.jsonl
*/tdai/recall-*.json
*.traj
*.patch
*.pred
preds.json
logs/run_evaluation/**/report.json
```

重点确认：

- recall 文件中存在 L1 relevant memories。
- prompt / trajectory 中确实包含 TDAI recall context。
- capture response 中 `l0_recorded > 0`。
- harness report 中 `patch_successfully_applied=true`。

