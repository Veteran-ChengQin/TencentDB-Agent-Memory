# 资产回写硬编码审计

## 结论

原 `doc2feat-seaborn-2643/scripts/collect-and-update-task.mjs` 把 Task、提交、资产名称及案例数据混在回写逻辑中，只能服务单个 Feature 案例。现已由清单驱动的 `benchmark/lib/task-run-finalizer.mjs` 替代；旧文件仅保留为兼容入口，并直接调用通用回写器。

## 运行时代码检查

已检查 `MemoryCore`、`MemoryKnowledge`、`MemoryPanel`、`MemoryProxy` 和 `benchmark/lib`：

- 未发现生产逻辑绑定 Seaborn、`move_legend`、PR #2643、Issue #3079、固定 Task/Agent ID 或固定提交；
- 任务关联面板原有的 `mwaskom/seaborn` 示例已改成中性文案“组织名/项目名”；
- 搜索结果中剩余的案例名称位于单元测试夹具，不参与运行时判断；
- `benchmark/cases/**` 中的任务描述、测试选择、Golden 资产和基线提交属于案例夹具，保留案例数据是预期行为。

## 防止再次出现静默遗漏

- 通用回写器的全部业务输入来自 `run-manifest.json` 与 `tdai-context.json`；
- Codex 与 CodeBuddy 的轨迹先归一化为统一 Session 结构，再进入相同的回写路径；
- 验证脚本发现 TDAI 上下文后必须调用通用回写器，缺少运行清单或回写失败会使验证命令失败；
- 回写以 Session ID 去重，重复执行不会重复写参与记录或运行历史；
- Agent 进程状态与产物验证状态分别记录。只要独立测试通过，代码、文档和会话候选仍可进入人工审核，不会因 Agent 在最终响应阶段异常而丢失。
