# 通用 Task 运行回写器

`task-run-finalizer.mjs` 在 Agent 退出并完成验证后运行。它不启动 Agent，也不依赖具体 benchmark；职责是将本地运行产物转换为 TDAI Task 的统一资产沉淀结构。Agent 是否正常退出与补丁是否通过独立验证会分别记录；资产能否进入审核以验证结果为准。

支持的会话格式：

- Codex CLI JSONL
- CodeBuddy JSONL

调用方式：

```powershell
node benchmark/lib/task-run-finalizer.mjs --manifest D:\path\to\run-manifest.json
```

运行清单示例：

```json
{
  "schema_version": 1,
  "task_kind": "feature",
  "workspace": "D:/workspace/repository",
  "runtime_dir": "D:/runtime/task-run",
  "instruction_file": "D:/case/instruction.md",
  "project": {
    "name": "project-name",
    "repo_url": "https://github.com/org/repository.git",
    "branch": "task-branch"
  },
  "session": {
    "summary_file": "agent-session.json",
    "transcript_file": "agent-session.jsonl"
  },
  "verification": [
    { "name": "功能测试", "command": "pytest F2P", "junit_file": "f2p-junit.xml" },
    { "name": "回归测试", "command": "pytest P2P", "junit_file": "p2p-junit.xml" }
  ]
}
```

`runtime_dir` 中还需存在 `tdai-context.json`，包含 `instance_id`、`team_id`、`task_id`、`agent_id` 和 `user_id`。回写器会自动：

1. 识别 Codex 或 CodeBuddy 轨迹并归一化；
2. 从 Git 工作区收集 Diff、变更文件及文档全文；
3. 解析 JUnit，生成可展开的验证结果；
4. 生成 Wiki、代码图谱和 Skill 候选；
5. 追加最终参与记录，并将 Task 更新为 `completed`；
6. 写入 `metadata.asset_deposition`，供任务看板直接展示。

项目、任务、模型、测试和路径都来自清单与运行上下文；回写器中不包含案例 ID、提交号或资产 ID。
