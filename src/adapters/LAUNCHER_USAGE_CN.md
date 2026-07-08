# TDAI 平台适配 Launcher 使用说明

本文档说明 OpenHands 和 SWE-agent 适配层的一键 launcher。设计目标是：

- 不修改 OpenHands / SWE-agent 核心逻辑。
- 不修改 TDAI Gateway 的 `/recall`、`/capture`、`/search` 语义。
- 用户 clone 仓库、安装依赖、配置 YAML 后，通过一个命令完成 Gateway 检查/启动、工程经验 seed 注入、平台启动。

## OpenHands

配置文件：

```text
src/adapters/openhands/configs/tdai-openhands-launcher.yaml
```

推荐流程：

```bash
cd /path/to/TencentDB-Agent-Memory
export PYTHONPATH="$PWD/src/adapters/openhands:$PYTHONPATH"
export TDAI_LLM_API_KEY="..."
python -m tdai_openhands.launcher \
  --launcher-config src/adapters/openhands/configs/tdai-openhands-launcher.yaml \
  terminal
```

launcher 会做三件事：

1. 检查 `tdai-longterm-only.yaml` 中的 TDAI Gateway 地址是否可用。
2. 如果不可用且 `gateway.auto_start=true`，自动执行 `node --import tsx src/gateway/server.ts` 启动 Gateway。
3. 根据 `seed` 配置注入 SWE-bench/bug-fix 工程经验，然后进入 OpenHands 交互终端。

如果只想注入 seed，不进入 OpenHands：

```bash
python -m tdai_openhands.launcher \
  --launcher-config src/adapters/openhands/configs/tdai-openhands-launcher.yaml \
  seed
```

OpenHands 的实际终端入口由 `openhands.command` 控制。为空时会自动尝试 `openhands` 和 `openhands-cli`。如果你的安装方式不同，把命令写入 YAML，例如：

```yaml
openhands:
  command: ["python", "-m", "openhands.cli.main"]
```

## SWE-agent

配置文件：

```text
src/adapters/swe-agent/configs/tdai-sweagent-launcher.yaml
```

推荐流程：

```bash
cd /path/to/TencentDB-Agent-Memory
export PYTHONPATH="$PWD/src/adapters/swe-agent:/path/to/SWE-agent:$PYTHONPATH"
export TDAI_LLM_API_KEY="..."
python -m tdai_swe_agent.launcher \
  --launcher-config src/adapters/swe-agent/configs/tdai-sweagent-launcher.yaml \
  run
```

launcher 会做四件事：

1. 检查或自动启动 TDAI Gateway。
2. 注入工程经验 seed。
3. 按 `swe_agent.python_paths` 补充本地 SWE-agent 源码路径。
4. 调用既有 `tdai_swe_agent.runner` 启动 SWE-agent bug-fix 流程。

如果只想注入 seed：

```bash
python -m tdai_swe_agent.launcher \
  --launcher-config src/adapters/swe-agent/configs/tdai-sweagent-launcher.yaml \
  seed
```

可以在 launcher 命令末尾追加 SWE-agent 参数，它们会被附加到 YAML 中的 `swe_agent.args` 之后：

```bash
python -m tdai_swe_agent.launcher \
  --launcher-config src/adapters/swe-agent/configs/tdai-sweagent-launcher.yaml \
  run -- --instances.filter django__django-12345
```

## 需要用户配置的参数

最少需要确认：

- `gateway.env.TDAI_DATA_DIR`：记忆数据库目录。
- `gateway.env.TDAI_LLM_MODEL` / `gateway.env.TDAI_LLM_BASE_URL`：用于 L1/L2/L3 抽取的模型配置。
- `TDAI_LLM_API_KEY`：建议放在 shell 环境变量中，不写入 YAML。
- OpenHands 的 `openhands.command`，如果本机没有 `openhands` 或 `openhands-cli` 可执行入口。
- SWE-agent 的 `swe_agent.python_paths`、`swe_agent.args`、模型参数和 SWE-agent config 路径。

## Seed 行为

示例配置默认使用 `builtin: swe_bugfix`，会注入 5 条软件工程/bug-fix 经验。也可以改用 `seed.items` 或 `seed.file`。

为避免 TDAI 后台 L1 抽取队列被快速连续请求跳过，launcher 默认每条 seed 间隔 `20s`，并在结束后调用 `/session/end`。这个设置偏保守，但更接近前面实验中能稳定抽取 L1/L2/L3 的方式。

如果希望 seed 后马上启动真实 agent 并尽量看到召回效果，可以设置：

```yaml
seed:
  post_session_end_wait_seconds: 60
```

它会在 `/session/end` 后额外等待一段时间，让后台 L1/L2/L3 异步抽取有机会完成。
