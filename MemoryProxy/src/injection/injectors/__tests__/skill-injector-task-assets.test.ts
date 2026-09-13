import { describe, expect, it } from "vitest";
import { wrapAvailableSkillsBlock } from "../skill-injector.js";

describe("task recommended skill catalog", () => {
  it("adds task-selected skills without modifying the agent listing", () => {
    const output = wrapAvailableSkillsBlock(
      "<available_skills>\n- agent-skill: existing\n</available_skills>",
      [{
        assetId: "skl-1",
        assetType: "skill",
        name: "API compatibility handling",
        sourceTaskId: "task-feature",
      }],
    );

    expect(output).toContain("agent-skill: existing");
    expect(output).toContain("<task_recommended_skills>");
    expect(output).toContain("API compatibility handling");
    expect(output).toContain("task-feature");
  });
});
