# Seaborn Issue #3079 Bug Fix 资产复用实验

该 case 从 Seaborn Issue #3079 构造 Bug Fix Task，用于验证 Bug Agent 能否通过 TDAI 使用此前 PR #2643 Feature Task 沉淀的项目 Wiki、代码图谱和 Skill。

- 修复前基线：`01fddcfa8724ff0e9aea475d9370051a0f5ef73c`
- 上游修复：PR #3454，最终提交 `6c72a618cc3ff52bb927dd8bc12945af12d807d2`
- CodeBuddy：`gpt-5.6-sol`，500 turns，禁用计划模式，经 TDAI Proxy 调用
- F2P：标签替换保持 handle/颜色顺序；错误标签数量抛出 `ValueError`
- P2P：已有 `move_legend` 与 utility 回归测试

运行顺序：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-workspace.ps1
powershell -ExecutionPolicy Bypass -File scripts/build-work-image.ps1
node scripts/prepare-tdai-context.mjs
powershell -ExecutionPolicy Bypass -File scripts/run-codebuddy.ps1
powershell -ExecutionPolicy Bypass -File scripts/verify.ps1
```

隐藏 F2P 只在验证阶段临时复制到 workspace，执行后立即删除。CodeBuddy 只接收 `instruction.zh-CN.md`。
