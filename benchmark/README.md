# Benchmark 运行与 TDAI 回写边界

本目录分为两层：

- `lib/`：与具体考题无关的运行基础设施。Agent 完成后统一使用 `task-run-finalizer.mjs` 归一化会话、采集 Git Diff、解析 JUnit，并回写 TDAI Task。
- `cases/`：用于验证的案例夹具。任务说明、基线提交、F2P/P2P、Golden Patch 和工作区均允许包含具体项目数据，但不得被产品运行时代码依赖。

只要一次运行需要同步到 TDAI，就必须在运行目录提供 `tdai-context.json` 和 `run-manifest.json`。案例验证脚本检测到前者而缺少后者时会直接失败，避免出现“测试完成但资产没有回写”的静默遗漏。

通用回写协议及清单格式见 [lib/task-run-finalizer.md](lib/task-run-finalizer.md)。
