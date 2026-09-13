import { describe, expect, it } from "vitest";

import { applyTaskCanonicalProject } from "../knowledge-tools-injector.js";
import type { KnowledgeItem } from "../../../knowledge/core-client.js";

const resources: KnowledgeItem[] = [
  {
    knowledge_id: "cg-snapshot",
    type: "code-graph",
    service_url: "http://knowledge/v3",
    name: "Task snapshot",
    summary: null,
    team_id: "team-1",
    user_id: "user-1",
    repo_url: "https://github.com/team-fork/tdai-snapshot-seaborn.git",
    branch: "tdai/task-1/abc",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
  {
    knowledge_id: "wiki-1",
    type: "wiki",
    service_url: "http://knowledge/v3",
    name: "Wiki",
    summary: null,
    team_id: "team-1",
    user_id: "user-1",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
];

describe("task snapshot code graph anchoring", () => {
  it("uses the Task canonical project only for Task-scoped code graphs", () => {
    const result = applyTaskCanonicalProject(resources, new Set(["cg-snapshot", "wiki-1"]), "mwaskom/seaborn");
    expect(result[0]?.repo_slug).toBe("mwaskom/seaborn");
    expect(result[1]?.repo_slug).toBeUndefined();
    expect(resources[0]?.repo_slug).toBeUndefined();
  });
});
