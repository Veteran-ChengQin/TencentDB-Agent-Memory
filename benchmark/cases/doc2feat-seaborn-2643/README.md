# Doc2Feat Seaborn #2643：CodeBuddy 资产沉淀验证

本 case 使用 Doc2Feat-Bench 的 `mwaskom__seaborn-2643`。它从 Seaborn 的干净基线 `091f4c0e...` 启动，由 CodeBuddy 根据文档实现 `move_legend`，再把任务证据和 Wiki/CKG/Skill 合并计划写回 TDAI Task。

## 一次完整运行

在本目录执行：

```powershell
# 1. 启动 TDAI 后，创建/复用中文 CodeBuddy Agent 和 #2643 Task
node scripts/create-tdai-task.mjs

# 2. 克隆干净仓库并安装隔离依赖（首次较慢）
powershell -ExecutionPolicy Bypass -File scripts/prepare-workspace.ps1

# 3. 启动 CodeBuddy（默认最多 500 轮）；Team/Agent/Task 通过请求头绑定
powershell -ExecutionPolicy Bypass -File scripts/run-codebuddy.ps1 -MaxTurns 500

# 4. 执行 F2P/P2P，采集产物并回写 Task
powershell -ExecutionPolicy Bypass -File scripts/verify-and-collect.ps1
```

默认读取 `deploy/global-images/.admin-key`，也可用环境变量覆盖：`TDAI_USER_KEY`、`TDAI_TEAM_ID`、`TDAI_INSTANCE_ID`、`TDAI_CORE_URL`、`TDAI_PROXY_PORT`、`TDAI_UPSTREAM_MODEL`。TDAI 当前要求 CodeBuddy 从用户级 `~/.codebuddy/models.json` 读取自定义模型；脚本会先备份原内容，临时写入 Proxy 配置，并在 CodeBuddy 退出后原样恢复或删除，因此密钥不会进入资产包。

如果当前 CodeBuddy 版本或账号策略禁用了自定义模型，可加 `-DirectCloud` 使用已登录的 CodeBuddy 云端模型完成任务。此时采集器会把外部 CodeBuddy Session 作为 Task 参与记录补写到 TDAI，但该次运行不会验证 Proxy 的资产注入能力。

## UI 中应看到什么

新建 Task 时不会预先展示资产。Agent 运行结束并由通用回写器采集到 Session、Diff 或测试结果后，任务详情底部才会出现“资产沉淀”：

- Task 证据包：CodeBuddy Session、工作区 diff、测试日志，状态为“已保存”；
- Wiki：列出本次文档变更；仅在 F2P 通过后才可选择团队 Wiki 并批准合并；
- CKG：列出代码/测试变更及预期结果版本；仅在 F2P 通过后才可同步；
- Skill：仅对验证通过的 Session 保留候选计划；失败 Session 作为 Task 证据，不直接发布 Skill。

`artifacts/runs/` 是按实验隔离的运行产物，不纳入版本控制。`artifacts/asset-package.initial.zh-CN.json` 仅作为链路测试夹具，不会在创建 Task 时写入 UI。

## 验证口径

F2P 使用四个验收节点，覆盖输入校验、Axes/Figure、Seaborn Grid 和一个既有数据加载行为；其中新增测试从 benchmark verifier 临时复制到工作区，执行后删除，Agent 看不到隐藏测试。测试环境固定为 Pandas 1.5.3，以兼容该版本 Seaborn 使用的 `DataFrame.iteritems()`。P2P 选取六个已有 utility 测试验证回归。Agent 运行结束后 Task 标记为“已完成”，功能成败由独立的验证状态表示；F2P 失败会阻断 Wiki、CKG 和 Skill 合并。

## Golden Patch 链路验证

以下命令在独立工作区应用 Doc2Feat Golden Patch，先用 F2P/P2P 打开发布门禁，再实际创建和加工专用 Wiki、构建专用 CKG，最后对 Task 元数据、参与记录和知识检索做端到端断言：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run-golden-validation.ps1
node scripts/publish-golden-wiki.mjs
node scripts/publish-golden-ckg.mjs
node scripts/validate-golden-assets.mjs
```

Wiki ingest 只支持 `.md/.txt`，上传器会把 `.rst` 和 `.ipynb` 规范化为 Markdown；Task manifest 仍保留原始文件路径。CKG 使用包含该功能的 `v0.11.2` 发布标签作为可重复同步点，避免把历史 Golden commit 伪装为长期分支。Golden Session 仅用于管理链路验证，不提取 Skill，防止评测答案泄漏。

## 本次执行结果

Golden Patch：

- F2P：2 通过 / 0 失败 / 1 网络跳过；P2P：5 通过 / 0 失败 / 1 网络跳过；
- Task 证据包已保存，参与记录已回写；
- Wiki `wiki-u7alc0hs` 已完成源文件上传、ingest 和检索；
- CKG `cg-sxkiizuv` 已构建完成，包含 101 个文件、2307 个节点、5389 条边；
- Skill 被标记为“已跳过”，原因是 Golden Patch 属于评测 Oracle。

CodeBuddy 500 轮实验：

- CodeBuddy 云端 `glm-5.2`，上限设为 500，在第 141 轮主动结束；
- 改动：`doc/api.rst`、`seaborn/axisgrid.py`；
- F2P：0 通过 / 2 失败 / 1 跳过，失败原因是 `seaborn.utils.move_legend` 未实现；
- P2P：5 通过 / 0 失败 / 1 跳过；
- Task 证据包已保存，Wiki、CKG、Skill 均标记为“验证阻断”。

Codex gpt-5.6-sol v2 对照实验：

- 修正任务规格，明确支持 Matplotlib `Figure`；测试环境固定为 Pandas 1.5.3，并向 Codex 提供专用 Python 解释器路径；
- Codex 在 1 个 turn 中执行 14 个操作 step（10 次命令、4 次文件修改），运行约 8 分 47 秒；
- 改动：`doc/api.rst`、`seaborn/utils.py`、`seaborn/tests/test_utils.py`，新增 157 行、删除 1 行；
- 独立 F2P：3 通过、0 失败、1 网络跳过；其中 Axes/Figure 与 Grid 验收均通过；
- P2P：5 通过、0 失败、1 网络跳过；Task 证据和参与记录已写回 TDAI。
