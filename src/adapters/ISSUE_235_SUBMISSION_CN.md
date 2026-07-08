# Issue #235 平台适配提交说明

本文档记录本次针对 TencentCloud/TencentDB-Agent-Memory#235 的提交范围、设计取舍、与既有 PR 的差异，以及从全新 clone 到 launcher 启动的验证流程。

## Issue #235 需求对照

Issue #235 的核心目标是让 TencentDB Agent Memory 能接入更多 Agent 平台。验收标准分为四层：

- 基础：阅读 `TdaiCore`、Gateway、已有适配层，梳理核心接口和数据流。
- 进阶：选择一个新平台，实现基本记忆读写能力。
- 深入：适配两个或以上平台，并编写平台差异和接入文档。
- 拓展：沉淀统一接入方法，使新平台接入更轻量。

本次实现聚焦“深入”层级，并覆盖部分“拓展”目标：

- 新增 OpenHands 适配层。
- 新增 SWE-agent 适配层。
- 两个平台均通过 TDAI Gateway 复用 `/recall`、`/capture`、`/search/memories`、`/search/conversations`。
- 不修改 OpenHands / SWE-agent 核心逻辑。
- 不修改 TDAI Gateway legacy `/recall.context` 语义。
- 增加一键 launcher，把 Gateway 检查/启动、工程经验 seed 注入、平台启动流程收敛到单个命令。

## 与 PR #385 的对比

PR #385 的主要贡献是：

- 新增 Claude Code 和 CodeBuddy TypeScript 平台适配。
- 复用项目原生 `HostAdapter` 模式。
- 新增共享类型和平台适配文档。
- 提供 Gateway/MCP/多平台 E2E 验证说明。

本次实现与 PR #385 的关系是互补而不是替代：

- PR #385 是偏 TypeScript / IDE 平台的横向接入，适合复用 `HostAdapter`。
- 本次实现面向 OpenHands 和 SWE-agent，它们是 Python 生态的软件工程 Agent 平台，不能直接复用 TypeScript `HostAdapter`。
- 本次实现选择 Gateway HTTP 边界作为稳定接口，把 TDAI 作为外部 memory service 接入。
- 本次实现强调 SWE-bench bug-fix 场景：支持在真实 issue 修复任务前召回 long-term memory，在任务后 capture 轨迹/patch/事件，并提供主动搜索工具。

## 设计原则

- 不改核心逻辑，只新增平台适配代码。
- 适配层只做编排、注入、capture、工具暴露。
- 召回 L1 memory 时，适配层额外调用 `/search/memories`，避免改变 Gateway `/recall` 的 legacy 行为。
- 工程经验 seed 通过标准 `/capture` 写入，再通过 `/session/end` 触发 TDAI 后台抽取。
- launcher 不保存真实 API key；模型 key 通过环境变量传入。

## 变更目录

应纳入本次 issue #235 提交的文件：

```text
.gitignore
package.json
src/adapters/index.ts
src/adapters/ISSUE_235_SUBMISSION_CN.md
src/adapters/LAUNCHER_USAGE_CN.md
src/adapters/openhands/
src/adapters/swe-agent/
```

不应纳入本次提交的文件：

```text
src/offload/
```

`src/offload` 当前包含 OpenClaw/TDAI compaction delegate 相关修复，属于另一个 bug-fix 方向，建议单独提交和 PR。

## OpenHands 使用方式

配置：

```text
src/adapters/openhands/configs/tdai-openhands-launcher.yaml
```

启动：

```bash
cd /path/to/TencentDB-Agent-Memory
export PYTHONPATH="$PWD/src/adapters/openhands:$PYTHONPATH"
export TDAI_LLM_API_KEY="..."
python -m tdai_openhands.launcher \
  --launcher-config src/adapters/openhands/configs/tdai-openhands-launcher.yaml \
  terminal
```

只注入工程经验 seed：

```bash
python -m tdai_openhands.launcher \
  --launcher-config src/adapters/openhands/configs/tdai-openhands-launcher.yaml \
  seed
```

## SWE-agent 使用方式

配置：

```text
src/adapters/swe-agent/configs/tdai-sweagent-launcher.yaml
```

启动：

```bash
cd /path/to/TencentDB-Agent-Memory
export PYTHONPATH="$PWD/src/adapters/swe-agent:/path/to/SWE-agent:$PYTHONPATH"
export TDAI_LLM_API_KEY="..."
python -m tdai_swe_agent.launcher \
  --launcher-config src/adapters/swe-agent/configs/tdai-sweagent-launcher.yaml \
  run
```

只注入工程经验 seed：

```bash
python -m tdai_swe_agent.launcher \
  --launcher-config src/adapters/swe-agent/configs/tdai-sweagent-launcher.yaml \
  seed
```

## 本地验证结果

当前工作区已完成：

```text
python -m py_compile src/adapters/openhands/tdai_openhands/launcher.py src/adapters/swe-agent/tdai_swe_agent/launcher.py
python -m pytest src/adapters/openhands/tests -q
python -m pytest src/adapters/swe-agent/tests -q
```

结果：

```text
OpenHands adapter tests: 14 passed
SWE-agent adapter tests: 4 passed
```

## Clone 后 launcher 验证记录

待在全新目录 clone fork 分支后补充。
