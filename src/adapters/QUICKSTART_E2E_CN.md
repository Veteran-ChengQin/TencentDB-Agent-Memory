# WSL 原生 Quick Start：OpenHands / SWE-agent + TDAI + SWE-bench

本文给出一个 **Linux / WSL 原生** 的 quick start 流程：从空目录 clone 开始，安装 TencentDB Agent Memory（TDAI）、OpenHands、SWE-agent，注入软件工程经验 seed，并在真实 SWE-bench bug-fix 场景中验证 memory recall / capture。

目标读者假设尚未安装 OpenHands 和 SWE-agent。所有命令默认在 WSL Ubuntu 中执行，项目目录也放在 WSL 文件系统中，而不是 `/mnt/c` 或 `/mnt/d`。OpenHands 官方开发文档同样建议在 WSL 中把项目放在 Linux filesystem，否则文件访问会明显变慢。

本适配遵循一个边界原则：不修改 OpenHands / SWE-agent 核心逻辑，只新增平台适配层和 launcher。TDAI 仍通过 Gateway 的 `/recall`、`/capture`、`/search/memories`、`/search/conversations` 提供能力。

## 1. 总体目录

建议准备一个独立工作目录：

```bash
export ROOT="$HOME/tdai-swebench-e2e"
mkdir -p "$ROOT"
cd "$ROOT"
```

最终目录大致如下：

```text
~/tdai-swebench-e2e/
  TencentDB-Agent-Memory/
  OpenHands/
  SWE-agent/
  runs/
  tdai-data/
```

## 2. 系统前置条件

### 2.1 Docker

在 Windows + WSL 场景，推荐使用 Docker Desktop 并启用 WSL Integration。确认 WSL 中可直接调用 Docker：

```bash
docker version
docker run --rm hello-world
```

以 SWE-bench Verified 的 `pylint-dev__pylint-4551` 为例，需要本地存在 instance image：

```bash
docker image inspect swebench/sweb.eval.x86_64.pylint-dev_1776_pylint-4551:latest
```

如果没有该镜像，可以先拉取：

```bash
docker pull swebench/sweb.eval.x86_64.pylint-dev_1776_pylint-4551:latest
```

### 2.2 Node.js 22+

TDAI Gateway 和 OpenHands Agent Canvas 都需要较新的 Node.js。推荐用 `nvm`：

```bash
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
. "$NVM_DIR/nvm.sh"
nvm install 24
nvm use 24
nvm alias default 24

node -v
npm -v
```

### 2.3 Python

SWE-agent 当前要求 Python `>=3.11`。OpenHands 当前源码要求 Python `>=3.12,<3.14`。为了少维护一个解释器，建议统一准备 Python 3.12。

Ubuntu 22.04 可用 deadsnakes：

```bash
sudo apt update
sudo apt install -y software-properties-common build-essential curl git
sudo add-apt-repository -y ppa:deadsnakes/ppa
sudo apt update
sudo apt install -y python3.12 python3.12-dev python3.12-venv

python3.12 --version
```

也可以使用 conda / mamba 创建 Python 3.12 环境；核心要求是后续 `python --version` 显示 3.12.x。

## 3. Clone 三个仓库

```bash
cd "$ROOT"

git clone \
  --branch feat/openhands-swe-agent-tdai-adapters \
  --single-branch \
  https://github.com/Veteran-ChengQin/TencentDB-Agent-Memory.git

git clone https://github.com/OpenHands/OpenHands.git
git clone https://github.com/SWE-agent/SWE-agent.git
```

确认 TDAI 分支：

```bash
cd "$ROOT/TencentDB-Agent-Memory"
git log --oneline -1
```

## 4. 安装 TDAI

```bash
cd "$ROOT/TencentDB-Agent-Memory"
. "$NVM_DIR/nvm.sh"
nvm use 24
npm install
```

adapter 是 Python 代码，后续按平台分别把 adapter 路径加入 `PYTHONPATH`。

## 5. 安装 SWE-agent

SWE-agent 官方源码安装方式是 editable install：

```bash
cd "$ROOT/SWE-agent"
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install --editable .

sweagent --help
```

如果 `sweagent` 命令不在 PATH，也可以用：

```bash
python -m sweagent --help
```

## 6. 安装 OpenHands

OpenHands 当前 README 推荐两种常用方式。对于 quick start，可以先用 Agent Canvas；对于源码开发或本地 SDK runner，可以使用源码环境。

### 6.1 Agent Canvas 方式

```bash
. "$NVM_DIR/nvm.sh"
nvm use 24
npm install -g @openhands/agent-canvas

agent-canvas --help
```

这会提供交互式 OpenHands UI / local stack 入口。TDAI launcher 可以先完成 Gateway 检查和 seed 注入，然后把控制权交给 `agent-canvas`。

### 6.2 源码方式

OpenHands 源码要求 Python 3.12，并使用 Poetry / Makefile：

```bash
cd "$ROOT/OpenHands"
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install poetry

make build
```

启动：

```bash
make run
```

说明：`make run` 是完整 UI / backend 启动路径。若只是跑 SWE-bench E2E，可以让 `tdai_openhands.launcher` 的 `openhands.command` 指向你自己的 OpenHands SDK runner，而不是启动 UI。

## 7. 启动 TDAI Gateway

建议显式启动 Gateway，而不是依赖 launcher 在发现端口不可用时自动启动。这样可以清楚控制 `TDAI_DATA_DIR`。

```bash
cd "$ROOT/TencentDB-Agent-Memory"
. "$NVM_DIR/nvm.sh"
nvm use 24

export TDAI_DATA_DIR="$ROOT/tdai-data"
export TDAI_LLM_MODEL="deepseek-v4-flash"
export TDAI_LLM_BASE_URL="https://api.deepseek.com"
export TDAI_LLM_API_KEY="<your-api-key>"

node --import tsx src/gateway/server.ts
```

另开一个 WSL shell 做健康检查：

```bash
curl http://127.0.0.1:8420/health
```

如果已有旧 Gateway 正在占用 8420，新的 `TDAI_DATA_DIR` 不会生效。先停止旧进程：

```bash
pkill -f 'src/gateway/server.ts' || true
```

然后重新启动 Gateway。

可以确认当前 Gateway 使用的数据目录：

```bash
PID="$(pgrep -f 'src/gateway/server.ts' | head -n1)"
tr '\0' '\n' < "/proc/$PID/environ" | grep TDAI_DATA_DIR
```

TDAI 的本地层级不是 `l1/`、`l2/`、`l3/` 目录，而是：

```text
L0: conversations/*.jsonl + vectors.db:l0_conversations
L1: records/*.jsonl + vectors.db:l1_records
L2: scene_blocks/*.md
L3: persona.md
```

## 8. Seed 软件工程经验

`builtin`、`file`、`items` 是累加关系：

```text
最终 seed 数 = builtin 内置条数 + file 中条数 + items 中条数
```

例如：

```yaml
seed:
  builtin: "swe_bugfix"
  items:
    - "自定义经验 1"
    - "自定义经验 2"
```

会注入 `5 条内置 swe_bugfix + 2 条自定义 items = 7 条`。

如果只想注入自己写的 5 条，请删除 `builtin` 或设为 `null`：

```yaml
seed:
  builtin: null
  items:
    - "..."
```

### 8.1 OpenHands seed

```bash
cd "$ROOT/TencentDB-Agent-Memory"
source "$ROOT/OpenHands/.venv/bin/activate" 2>/dev/null || true
export PYTHONPATH="$PWD/src/adapters/openhands:$PYTHONPATH"

python -m tdai_openhands.launcher \
  --launcher-config src/adapters/openhands/configs/tdai-openhands-launcher.yaml \
  seed
```

### 8.2 SWE-agent seed

```bash
cd "$ROOT/TencentDB-Agent-Memory"
source "$ROOT/SWE-agent/.venv/bin/activate"
export PYTHONPATH="$PWD/src/adapters/swe-agent:$ROOT/SWE-agent:$PYTHONPATH"

python -m tdai_swe_agent.launcher \
  --launcher-config src/adapters/swe-agent/configs/tdai-sweagent-launcher.yaml \
  seed
```

建议在 launcher YAML 中保留：

```yaml
seed:
  enabled: true
  session_end: true
  post_session_end_wait_seconds: 30
```

`post_session_end_wait_seconds` 用于给 L1/L2/L3 异步抽取留出时间。

## 9. 准备 SWE-bench instance 输入

OpenHands recall / capture 示例会引用：

```text
$ROOT/runs/pylint-4551/problem_statement.txt
```

为了让 quick start 不依赖 Hugging Face 下载，仓库已经提供了一个可直接复制的示例：

```text
src/adapters/examples/swebench/pylint-dev__pylint-4551/
```

复制到 run 目录：

```bash
mkdir -p "$ROOT/runs/pylint-4551/tdai"
cp \
  "$ROOT/TencentDB-Agent-Memory/src/adapters/examples/swebench/pylint-dev__pylint-4551/problem_statement.txt" \
  "$ROOT/runs/pylint-4551/problem_statement.txt"
cp \
  "$ROOT/TencentDB-Agent-Memory/src/adapters/examples/swebench/pylint-dev__pylint-4551/metadata.json" \
  "$ROOT/runs/pylint-4551/metadata.json"
```

确认内容：

```bash
sed -n '1,80p' "$ROOT/runs/pylint-4551/problem_statement.txt"
cat "$ROOT/runs/pylint-4551/metadata.json"
```

示例 metadata 中固定了：

```text
instance_id: pylint-dev__pylint-4551
repo: pylint-dev/pylint
base_commit: 99589b08de8c5a2c6cc61e13a37420a868c80599
testbed_image: swebench/sweb.eval.x86_64.pylint-dev_1776_pylint-4551:latest
```

如果你要换成其他 SWE-bench instance，只需要提供同样两个文件：

```text
problem_statement.txt
metadata.json
```

并保证 `metadata.json` 中的 `instance_id`、`repo`、`base_commit` 和实际任务一致。

## 10. WSL 原生启动 OpenHands

### 10.1 交互式 OpenHands

如果使用 Agent Canvas：

```yaml
openhands:
  command:
    - "agent-canvas"
  cwd: "/home/<user>/tdai-swebench-e2e"
  python_paths: []
  pass_tdai_env: true
  env: {}
```

启动：

```bash
cd "$ROOT/TencentDB-Agent-Memory"
export PYTHONPATH="$PWD/src/adapters/openhands:$PYTHONPATH"

python -m tdai_openhands.launcher \
  --launcher-config src/adapters/openhands/configs/tdai-openhands-launcher.yaml \
  terminal
```

这条路径会完成：

1. 检查 TDAI Gateway。
2. 注入 seed。
3. 启动 OpenHands / Agent Canvas。

注意：交互式 UI 启动本身只证明 launcher 能把 OpenHands 启动起来。任务级 recall / capture 需要在 OpenHands start request 或任务 runner 中显式调用 `tdai_openhands.runner`。

### 10.2 SWE-bench E2E 模式

真实 SWE-bench E2E 需要三个阶段：

1. `tdai_openhands.runner recall`：任务开始前生成 `<tdai_recall_context>`。
2. OpenHands agent 解题：把 recall context 放入任务 prompt，并可配置 TDAI MCP 搜索工具。
3. `tdai_openhands.runner capture`：任务结束后把 events / trajectory / patch / metadata 写回 TDAI。

注意：`tdai_openhands.runner recall` **不会启动 OpenHands**。它只调用 TDAI Gateway，把召回结果写入 `recall.json` 或打印到 stdout。真正启动 OpenHands 的入口是 `tdai_openhands.launcher terminal`、`agent-canvas`、`make run`，或者你自己的 OpenHands SDK / App Server runner。

adapter 提供的是稳定边界命令，而不是强绑定某个 OpenHands 版本的 runner。因此实际 E2E runner 可以由你的 OpenHands 版本决定。最小边界命令如下：

```bash
cd "$ROOT/TencentDB-Agent-Memory"
source "$ROOT/OpenHands/.venv/bin/activate"
export PYTHONPATH="$PWD/src/adapters/openhands:$PYTHONPATH"

python -m tdai_openhands.runner \
  --tdai-config src/adapters/openhands/configs/tdai-longterm-only.yaml \
  recall \
  --instance-id pylint-dev__pylint-4551 \
  --repo pylint-dev/pylint \
  --base-commit 99589b08de8c5a2c6cc61e13a37420a868c80599 \
  --problem-file "$ROOT/runs/pylint-4551/problem_statement.txt" \
  --tdai-run-id openhands-tdai-pylint-4551 \
  --output "$ROOT/runs/pylint-4551/tdai/recall.json"
```

此时只会生成：

```text
$ROOT/runs/pylint-4551/tdai/recall.json
```

可以检查召回内容：

```bash
python - <<'PY'
import json
import os
from pathlib import Path

p = Path(os.environ["ROOT"]) / "runs/pylint-4551/tdai/recall.json"
data = json.loads(p.read_text())
print("context_len:", len(data.get("context", "")))
print(data.get("context", "")[:1200])
print("errors:", {
    "recall": (data.get("payload", {}).get("recall") or {}).get("_tdai_error"),
    "l1_search": (data.get("payload", {}).get("l1_search") or {}).get("_tdai_error"),
})
PY
```

如果希望先人工验证，可以把 `context` 和 `problem_statement.txt` 合并到 OpenHands 的初始任务消息中。若你通过 OpenHands App Server API 启动任务，则使用 `prepare-request` 自动注入：

```bash
python -m tdai_openhands.runner \
  --tdai-config src/adapters/openhands/configs/tdai-longterm-only.yaml \
  prepare-request \
  --request-file "$ROOT/runs/pylint-4551/openhands_start_request.json" \
  --instance-id pylint-dev__pylint-4551 \
  --repo pylint-dev/pylint \
  --base-commit 99589b08de8c5a2c6cc61e13a37420a868c80599 \
  --problem-file "$ROOT/runs/pylint-4551/problem_statement.txt" \
  --tdai-run-id openhands-tdai-pylint-4551 \
  --output "$ROOT/runs/pylint-4551/openhands_start_request.tdai.json"
```

OpenHands 解题完成后：

```bash
python -m tdai_openhands.runner \
  --tdai-config src/adapters/openhands/configs/tdai-longterm-only.yaml \
  capture \
  --instance-id pylint-dev__pylint-4551 \
  --repo pylint-dev/pylint \
  --base-commit 99589b08de8c5a2c6cc61e13a37420a868c80599 \
  --problem-file "$ROOT/runs/pylint-4551/problem_statement.txt" \
  --events-file "$ROOT/runs/pylint-4551/openhands_events.jsonl" \
  --patch-file "$ROOT/runs/pylint-4551/patch.diff" \
  --metadata-file "$ROOT/runs/pylint-4551/metadata.json" \
  --tdai-run-id openhands-tdai-pylint-4551 \
  --output "$ROOT/runs/pylint-4551/tdai/capture_response.json"
```

## 11. WSL 原生启动 SWE-agent

SWE-agent adapter 已经能直接包装 `RunBatch`，因此 quick start 更直接。

先编辑：

```text
src/adapters/swe-agent/configs/tdai-sweagent-launcher.yaml
```

确保：

```yaml
swe_agent:
  python_paths:
    - "/home/<user>/tdai-swebench-e2e/SWE-agent"
```

启动：

```bash
cd "$ROOT/TencentDB-Agent-Memory"
source "$ROOT/SWE-agent/.venv/bin/activate"
export PYTHONPATH="$PWD/src/adapters/swe-agent:$ROOT/SWE-agent:$PYTHONPATH"

python -m tdai_swe_agent.launcher \
  --launcher-config src/adapters/swe-agent/configs/tdai-sweagent-launcher.yaml \
  run
```

launcher 会完成：

1. 检查 TDAI Gateway。
2. 注入 seed。
3. 调用 `tdai_swe_agent.runner`。
4. 在 SWE-agent history processor 中注入 TDAI recall context。
5. run 结束后通过 capture hook 写回 trajectory / patch / metadata。

如果启用主动搜索工具，SWE-agent 可调用：

- `tdai_memory_search`
- `tdai_conversation_search`

注意：不要从包含 `docker/` 子目录的仓库根目录启动 SWE-agent launcher。某些 SWE-agent 版本的路径归一化逻辑可能把 `deployment.type: docker` 误处理成文件路径。建议从独立 run 目录启动，并使用绝对路径传入 launcher config。

## 12. SWE-bench harness

如果已经生成 predictions：

```bash
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --split test \
  --predictions_path "$ROOT/runs/pylint-4551/preds.json" \
  --max_workers 1 \
  --instance_ids pylint-dev__pylint-4551 \
  --run_id tdai-quickstart-pylint-4551 \
  --timeout 1800
```

关键检查项：

```text
patch_successfully_applied=true
resolved=true/false
```

`resolved=false` 代表模型 patch 没有修好该 instance，不代表 TDAI adapter 失败。TDAI adapter 的验证重点是：

- recall 文件中存在 L1 relevant memories。
- prompt / trajectory 中包含 TDAI recall context。
- capture response 中 `l0_recorded > 0`。
- harness 能正常读取 patch 并完成评测。

## 13. 产物检查清单

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

TDAI 数据目录：

```bash
find "$TDAI_DATA_DIR" -maxdepth 3 -type f
sqlite3 "$TDAI_DATA_DIR/vectors.db" 'select count(*) from l0_conversations;'
sqlite3 "$TDAI_DATA_DIR/vectors.db" 'select count(*) from l1_records;'
ls "$TDAI_DATA_DIR/scene_blocks" 2>/dev/null || true
test -f "$TDAI_DATA_DIR/persona.md" && sed -n '1,120p' "$TDAI_DATA_DIR/persona.md"
```

## 14. 已完成的本地 E2E 结果摘要

此前已用 `pylint-dev__pylint-4551` 做过真实 bug-fix 端到端验证：

### SWE-agent

- 从 fork clone 的 TDAI adapter 启动。
- TDAI recall 成功注入，`injected_context` 约 5.7k chars。
- recall 包含 L1 relevant memories 与 user persona。
- run 结束后 capture 成功，`l0_recorded=127`。
- SWE-bench harness 完成，`patch_successfully_applied=true`，`resolved=false`。

### OpenHands

- 从 fork clone 的 TDAI adapter 启动 launcher。
- TDAI recall 成功注入，context 达到配置上限 6000 chars。
- OpenHands MCP 初始化成功，加载 2 个 TDAI 搜索工具。
- run 结束后 capture 成功，`l0_recorded=32`。
- SWE-bench harness 完成，`patch_successfully_applied=true`，`resolved=false`。

需要说明：上述 OpenHands 本地验证使用了 Windows 侧已有 OpenHands venv。它证明了 adapter 真实可用，但不适合作为 quick start 视频路径。录制 quick start 时应采用本文的 WSL 原生流程。
