import { describe, expect, it } from "vitest";
import { wrapAvailableSkillsBlock } from "../skill-injector.js";

describe("task recommended skill catalog", () => {
  it("adds task-selected skills without modifying the agent listing", () => {
    const output = wrapAvailableSkillsBlock(
      "<available_skills>\n- agent-skill: existing\n</available_skills>",
      [{
        assetId: "skl-1",
        assetType: "skill",
        name: "Matplotlib 图例兼容处理",
        sourceTaskId: "task-feature-2643",
      }],
    );

    expect(output).toContain("agent-skill: existing");
    expect(output).toContain("<task_recommended_skills>");
    expect(output).toContain("Matplotlib 图例兼容处理");
    expect(output).toContain("task-feature-2643");
  });
});
