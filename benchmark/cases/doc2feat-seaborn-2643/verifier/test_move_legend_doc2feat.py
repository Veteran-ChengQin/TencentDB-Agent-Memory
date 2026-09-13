import matplotlib as mpl
import matplotlib.pyplot as plt
import pytest

from seaborn import utils


def test_move_legend_matplotlib_objects():
    fig, ax = plt.subplots()
    colors = "C2", "C5"
    labels = "first label", "second label"
    title = "the legend"

    for color, label in zip(colors, labels):
        ax.plot([0, 1], color=color, label=label)
    ax.legend(loc="upper right", title=title)
    utils._draw_figure(fig)
    xfm = ax.transAxes.inverted().transform
    old_pos = xfm(ax.legend_.legendPatch.get_extents())

    new_fontsize = 14
    utils.move_legend(ax, "lower left", title_fontsize=new_fontsize)
    utils._draw_figure(fig)
    new_pos = xfm(ax.legend_.legendPatch.get_extents())

    assert (new_pos < old_pos).all()
    assert ax.legend_.get_title().get_text() == title
    assert ax.legend_.get_title().get_size() == new_fontsize

    new_title = "new title"
    utils.move_legend(ax, "lower left", title=new_title)
    utils._draw_figure(fig)
    assert ax.legend_.get_title().get_text() == new_title

    fig.legend(loc="upper right", title=title)
    utils._draw_figure(fig)
    xfm = fig.transFigure.inverted().transform
    old_pos = xfm(fig.legends[0].legendPatch.get_extents())

    utils.move_legend(fig, "lower left", title=new_title)
    utils._draw_figure(fig)
    new_pos = xfm(fig.legends[0].legendPatch.get_extents())

    assert (new_pos < old_pos).all()
    assert fig.legends[0].get_title().get_text() == new_title
    plt.close(fig)


def test_move_legend_grid_object(long_df):
    from seaborn.axisgrid import FacetGrid

    hue_var = "a"
    grid = FacetGrid(long_df, hue=hue_var)
    grid.map(plt.plot, "x", "y")
    grid.add_legend()
    utils._draw_figure(grid.figure)

    xfm = grid.figure.transFigure.inverted().transform
    old_pos = xfm(grid.legend.legendPatch.get_extents())
    fontsize = 20
    utils.move_legend(grid, "lower left", title_fontsize=fontsize)
    utils._draw_figure(grid.figure)
    new_pos = xfm(grid.legend.legendPatch.get_extents())

    assert (new_pos < old_pos).all()
    assert grid.legend.get_title().get_text() == hue_var
    assert grid.legend.get_title().get_size() == fontsize
    assert grid.legend.legendHandles
    for index, handle in enumerate(grid.legend.legendHandles):
        assert mpl.colors.to_rgb(handle.get_color()) == mpl.colors.to_rgb(f"C{index}")
    plt.close(grid.figure)


def test_move_legend_input_checks():
    _, ax = plt.subplots()
    with pytest.raises(TypeError):
        utils.move_legend(ax.xaxis, "best")
    with pytest.raises(ValueError):
        utils.move_legend(ax, "best")
    with pytest.raises(ValueError):
        utils.move_legend(ax.figure, "best")
    plt.close(ax.figure)
