import { describe, expect, it } from "vitest";

import { buildTaskCodeGraphDiff } from "./task-diff.js";

describe("buildTaskCodeGraphDiff", () => {
  it("extracts added files, entities and relations from a unified diff", () => {
    const patch = [
      "diff --git a/pkg/widget.py b/pkg/widget.py",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/pkg/widget.py",
      "@@ -0,0 +1,5 @@",
      "+from toolkit import render",
      "+class WidgetRenderer(BaseRenderer):",
      "+    pass",
      "+def render_widget(widget):",
      "+    return render(widget)",
    ].join("\n");

    const result = buildTaskCodeGraphDiff({ patch });

    expect(result.files).toEqual([{ path: "pkg/widget.py", change_type: "added", additions: 5, deletions: 0 }]);
    expect(result.entities.map((item) => [item.name, item.change_type])).toEqual([
      ["WidgetRenderer", "added"],
      ["render_widget", "added"],
    ]);
    expect(result.relations.some((item) => item.kind === "imports" && item.target === "toolkit")).toBe(true);
    expect(result.relations.some((item) => item.kind === "inherits" && item.target === "BaseRenderer")).toBe(true);
    expect(result.relations.some((item) => item.kind === "calls" && item.target === "render")).toBe(true);
  });

  it("uses complete snapshots to detect an existing entity body modification", () => {
    const patch = [
      "diff --git a/pkg/value.py b/pkg/value.py",
      "--- a/pkg/value.py",
      "+++ b/pkg/value.py",
      "@@ -2 +2 @@ def value():",
      "-    return old_value()",
      "+    return new_value()",
    ].join("\n");
    const result = buildTaskCodeGraphDiff({
      patch,
      before_files: { "pkg/value.py": "def value():\n    return old_value()\n" },
      after_files: { "pkg/value.py": "def value():\n    return new_value()\n" },
    });

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({ name: "value", change_type: "modified" });
    expect(result.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "old_value", change_type: "deleted" }),
      expect.objectContaining({ target: "new_value", change_type: "added" }),
    ]));
  });
});
