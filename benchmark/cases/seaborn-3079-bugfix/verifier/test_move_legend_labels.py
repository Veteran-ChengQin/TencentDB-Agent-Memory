import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pytest

import seaborn as sns
from seaborn import utils


def _scatter_with_semantic_legend():
    frame = pd.DataFrame(
        {
            "x": [0, 1, 2, 3, 4, 5],
            "y": [1, 2, 1, 3, 2, 4],
            "group": ["alpha", "beta", "gamma", "alpha", "beta", "gamma"],
        }
    )
    order = ["alpha", "beta", "gamma"]
    return sns.scatterplot(frame, x="x", y="y", hue="group", hue_order=order)


def _handle_colors(legend):
    # Matplotlib renamed this public compatibility surface across releases.
    # Keep the benchmark oracle independent of Seaborn's later helper.
    handles = getattr(legend, "legend_handles", None)
    if handles is None:
        handles = legend.legendHandles
    return [tuple(np.asarray(handle.get_facecolor()).reshape(-1).tolist()) for handle in handles]


def test_move_legend_relabels_without_reordering_handles():
    ax = _scatter_with_semantic_legend()
    before = _handle_colors(ax.get_legend())
    replacement = ["A", "B", "G"]

    utils.move_legend(ax, "best", labels=replacement)
    utils._draw_figure(ax.figure)

    assert [text.get_text() for text in ax.get_legend().get_texts()] == replacement
    assert _handle_colors(ax.get_legend()) == before
    plt.close(ax.figure)


def test_move_legend_rejects_wrong_label_count():
    ax = _scatter_with_semantic_legend()

    with pytest.raises(ValueError, match="Length of new labels"):
        utils.move_legend(ax, "best", labels=["only", "two"])

    plt.close(ax.figure)
