# 任务：根据文档为 Seaborn 增加 `move_legend`

请在当前 Seaborn 仓库中实现一个公开的便捷函数 `seaborn.move_legend`。它用于移动已有图例，而不是要求调用方重新提供图例数据。

文档给出的行为如下：

- 对 axes-level 图，支持 `sns.move_legend(ax, "center right")`；
- 支持直接传入带有图例的 Matplotlib `Figure`，例如在 `fig.legend(...)` 后调用 `sns.move_legend(fig, ...)`；
- 支持用 `bbox_to_anchor` 精细调整位置，包括把图例移到坐标轴外；
- 除位置外，调用方可以传入 Matplotlib `legend` 的其他关键字参数，例如 `ncol`、`title`、`title_fontsize` 和 `frameon`；
- 支持 figure-level 函数产生的 Seaborn Grid，例如 `FacetGrid`/`displot` 的返回对象；
- 应保留原图例的 handles、labels 和默认标题；调用方显式传入新标题时允许覆盖；
- 支持的宿主类型为 Seaborn `Grid`、Matplotlib `Axes` 和 Matplotlib `Figure`。其他对象应抛出 `TypeError`；上述支持类型尚无图例时应抛出 `ValueError`；
- 将该函数加入公开 API，并补充必要的代码内文档。不要复制或硬编码测试期望。

请先阅读仓库现有的图例创建方式和公开 API 组织方式，再完成实现。完成后运行与 `seaborn/tests/test_utils.py` 相关的测试，修复由本次修改引入的回归。不要提交 commit；采集器会统一记录工作区变更和验证结果。
