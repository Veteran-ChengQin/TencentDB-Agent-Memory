import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { knowledgeTaskCodeGraphChange } from "../db/schema.js";
import {
  buildTaskCodeGraphDiff,
  type BuildTaskCodeGraphDiffInput,
  type TaskCodeGraphDiff,
} from "../engines/code/task-diff.js";

export type TaskCodeGraphChangeStatus = "candidate" | "merged" | "obsolete";

export interface TaskCodeGraphChange {
  change_id: string;
  service_id: string;
  team_id: string;
  task_id: string;
  code_graph_id: string;
  base_commit: string;
  result_commit: string | null;
  result_snapshot: string | null;
  graph_commit: string | null;
  status: TaskCodeGraphChangeStatus;
  diff: TaskCodeGraphDiff;
  created_at: string;
  updated_at: string;
}

export interface BuildTaskCodeGraphChangeInput extends BuildTaskCodeGraphDiffInput {
  service_id: string;
  team_id: string;
  task_id: string;
  code_graph_id: string;
  base_commit: string;
  result_commit?: string;
  result_snapshot?: string;
  graph_commit?: string | null;
}

function commitsMatch(left?: string | null, right?: string | null): boolean {
  if (!left || !right) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function changeId(serviceId: string, taskId: string, codeGraphId: string): string {
  const suffix = createHash("sha256")
    .update(`${serviceId}\0${taskId}\0${codeGraphId}`)
    .digest("hex")
    .slice(0, 20);
  return `tcg-${suffix}`;
}

export class TaskCodeGraphChangeService {
  constructor(private readonly db: Db) {}

  build(input: BuildTaskCodeGraphChangeInput): TaskCodeGraphChange {
    const diff = buildTaskCodeGraphDiff(input);
    const existing = this.get(input.service_id, input.task_id, input.code_graph_id);
    const now = new Date().toISOString();
    const status: TaskCodeGraphChangeStatus = commitsMatch(input.result_commit, input.graph_commit)
      ? "merged"
      : "candidate";
    const resultSnapshot = input.result_snapshot
      ?? (input.result_commit
        ? null
        : `patch-sha256:${createHash("sha256").update(input.patch).digest("hex")}`);
    const values = {
      changeId: existing?.change_id ?? changeId(input.service_id, input.task_id, input.code_graph_id),
      serviceId: input.service_id,
      teamId: input.team_id,
      taskId: input.task_id,
      codeGraphId: input.code_graph_id,
      baseCommit: input.base_commit,
      resultCommit: input.result_commit ?? null,
      resultSnapshot,
      graphCommit: input.graph_commit ?? null,
      status,
      diffJson: JSON.stringify(diff),
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
    };

    this.db
      .insert(knowledgeTaskCodeGraphChange)
      .values(values)
      .onConflictDoUpdate({
        target: [
          knowledgeTaskCodeGraphChange.serviceId,
          knowledgeTaskCodeGraphChange.taskId,
          knowledgeTaskCodeGraphChange.codeGraphId,
        ],
        set: {
          teamId: values.teamId,
          baseCommit: values.baseCommit,
          resultCommit: values.resultCommit,
          resultSnapshot: values.resultSnapshot,
          graphCommit: values.graphCommit,
          status: values.status,
          diffJson: values.diffJson,
          updatedAt: values.updatedAt,
        },
      })
      .run();
    return this.get(input.service_id, input.task_id, input.code_graph_id)!;
  }

  get(serviceId: string, taskId: string, codeGraphId: string): TaskCodeGraphChange | null {
    const row = this.db
      .select()
      .from(knowledgeTaskCodeGraphChange)
      .where(and(
        eq(knowledgeTaskCodeGraphChange.serviceId, serviceId),
        eq(knowledgeTaskCodeGraphChange.taskId, taskId),
        eq(knowledgeTaskCodeGraphChange.codeGraphId, codeGraphId),
      ))
      .get();
    return row ? this.map(row) : null;
  }

  list(serviceId: string, teamId: string, taskId: string): TaskCodeGraphChange[] {
    return this.db
      .select()
      .from(knowledgeTaskCodeGraphChange)
      .where(and(
        eq(knowledgeTaskCodeGraphChange.serviceId, serviceId),
        eq(knowledgeTaskCodeGraphChange.teamId, teamId),
        eq(knowledgeTaskCodeGraphChange.taskId, taskId),
      ))
      .all()
      .map((row) => this.map(row));
  }

  updateStatus(
    serviceId: string,
    taskId: string,
    codeGraphId: string,
    status: TaskCodeGraphChangeStatus,
    graphCommit?: string | null,
  ): TaskCodeGraphChange | null {
    const existing = this.get(serviceId, taskId, codeGraphId);
    if (!existing) return null;
    this.db
      .update(knowledgeTaskCodeGraphChange)
      .set({ status, graphCommit: graphCommit ?? existing.graph_commit, updatedAt: new Date().toISOString() })
      .where(and(
        eq(knowledgeTaskCodeGraphChange.serviceId, serviceId),
        eq(knowledgeTaskCodeGraphChange.taskId, taskId),
        eq(knowledgeTaskCodeGraphChange.codeGraphId, codeGraphId),
      ))
      .run();
    return this.get(serviceId, taskId, codeGraphId);
  }

  deleteByCodeGraph(serviceId: string, codeGraphId: string): void {
    this.db
      .delete(knowledgeTaskCodeGraphChange)
      .where(and(
        eq(knowledgeTaskCodeGraphChange.serviceId, serviceId),
        eq(knowledgeTaskCodeGraphChange.codeGraphId, codeGraphId),
      ))
      .run();
  }

  reconcile(serviceId: string, taskId: string, codeGraphId: string, graphCommit: string | null): TaskCodeGraphChange | null {
    const existing = this.get(serviceId, taskId, codeGraphId);
    if (!existing) return null;
    if (existing.status === "merged" || !commitsMatch(existing.result_commit, graphCommit)) return existing;
    return this.updateStatus(serviceId, taskId, codeGraphId, "merged", graphCommit);
  }

  private map(row: typeof knowledgeTaskCodeGraphChange.$inferSelect): TaskCodeGraphChange {
    return {
      change_id: row.changeId,
      service_id: row.serviceId,
      team_id: row.teamId,
      task_id: row.taskId,
      code_graph_id: row.codeGraphId,
      base_commit: row.baseCommit,
      result_commit: row.resultCommit,
      result_snapshot: row.resultSnapshot,
      graph_commit: row.graphCommit,
      status: row.status as TaskCodeGraphChangeStatus,
      diff: JSON.parse(row.diffJson) as TaskCodeGraphDiff,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }
}
