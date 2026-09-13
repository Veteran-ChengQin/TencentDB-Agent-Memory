import { describe, expect, it } from "vitest";

import { createDb } from "../db/client.js";
import { TaskCodeGraphChangeService } from "./task-code-graph-change-service.js";

describe("TaskCodeGraphChangeService", () => {
  it("upserts one task-to-project-graph delta and reconciles its commit", () => {
    const { db, raw } = createDb({ path: ":memory:" });
    const service = new TaskCodeGraphChangeService(db);
    const patch = [
      "diff --git a/a.py b/a.py",
      "--- a/a.py",
      "+++ b/a.py",
      "@@ -0,0 +1,2 @@",
      "+def feature():",
      "+    return helper()",
    ].join("\n");

    const created = service.build({
      service_id: "memory-1",
      team_id: "team-1",
      task_id: "task-1",
      code_graph_id: "cg-1",
      base_commit: "base123",
      result_commit: "result123456789",
      graph_commit: "base123",
      patch,
    });
    expect(created.status).toBe("candidate");
    expect(created.diff.entities.map((item) => item.name)).toContain("feature");

    const reconciled = service.reconcile("memory-1", "task-1", "cg-1", "result123456");
    expect(reconciled?.status).toBe("merged");
    expect(service.list("memory-1", "team-1", "task-1")).toHaveLength(1);
    raw.close();
  });
});
