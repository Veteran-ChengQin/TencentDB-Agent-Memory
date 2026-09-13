import { describe, expect, it } from "vitest";
import { parseTaskAssetUsage, toTaskDetail } from "../task-asset-usage.js";

describe("task asset usage metadata", () => {
  it("parses only supported, well-formed enabled assets", () => {
    const parsed = parseTaskAssetUsage(JSON.stringify({
      asset_usage: {
        schema_version: 1,
        task_kind: "bug",
        project_key: "mwaskom/seaborn",
        enabled_assets: [
          {
            asset_id: "wiki-1",
            asset_type: "llm_wiki",
            name: "Seaborn Wiki",
            source_task_id: "task-feature",
          },
          { asset_id: "", asset_type: "skill", name: "invalid" },
          { asset_id: "secret", asset_type: "unsupported", name: "invalid" },
        ],
      },
    }));

    expect(parsed).toEqual({
      taskKind: "bug",
      projectKey: "mwaskom/seaborn",
      enabledAssets: [{
        assetId: "wiki-1",
        assetType: "llm_wiki",
        name: "Seaborn Wiki",
        sourceTaskId: "task-feature",
      }],
    });
  });

  it("keeps malformed metadata out of session context", () => {
    expect(parseTaskAssetUsage("not json")).toBeUndefined();
    expect(toTaskDetail({
      task_id: "task-bug",
      team_id: "team-1",
      title: "Fix move_legend",
      metadata_json: "not json",
    })).toEqual({
      id: "task-bug",
      name: "Fix move_legend",
      description: undefined,
      assetUsage: undefined,
    });
  });
});
