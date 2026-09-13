# Bug 修复：`move_legend` 重命名标签时图例含义错配

Seaborn Issue #3079 报告：在已有 Seaborn 图例上调用 `move_legend` 并通过 `labels` 重命名图例项时，新文本可能与原来的图例 handle、颜色顺序错配。

最小复现：

```python
penguins = sns.load_dataset("penguins")
ax = sns.histplot(data=penguins, x="flipper_length_mm", hue="species")
sns.move_legend(ax, "best", labels=["Adelie", "Chinstrap", "Gentoo"])
```

用户传入 `labels` 的目的是只修改图例显示文本，例如换成更短的名称，而不是改变数据或重新选择图例 handle。

请修复 `move_legend`，满足以下行为：

- 使用 `labels` 覆盖已有图例文本时，必须保持原有 handle 的数量、顺序和颜色对应关系；
- 新标签应按原图例顺序逐项替换；
- 新标签数量与已有图例项数量不一致时，应抛出说明明确的 `ValueError`，不能静默产生错误图例；
- 不传 `labels` 时，现有的 Axes、Figure 和 Seaborn Grid 图例移动行为不能回归；
- 补充针对该缺陷的回归测试，并运行相关测试验证。

请先阅读当前仓库实现和已有测试，再完成最小且兼容的修复。
