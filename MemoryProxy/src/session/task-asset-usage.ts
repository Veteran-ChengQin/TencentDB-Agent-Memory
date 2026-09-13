import type { TaskEntity } from "../meta/client.js";
import type {
  TaskAssetUsageDetail,
  TaskDetail,
  TaskUsableAssetDetail,
  TaskUsableAssetType,
} from "./types.js";

const ASSET_TYPES = new Set<TaskUsableAssetType>([
  "llm_wiki",
  "code_graph",
  "skill",
  "chat_memory",
]);

function text(value: unknown): string {``
  return typeof value === "string" ? value.trim() : "";
}

export function parseTaskAssetUsage(metadataJson: string | null | undefined): TaskAssetUsageDetail | undefined {
  if (!metadataJson) return undefined;
  try {
    const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
    const raw = metadata.asset_usage as Record<string, unknown> | undefined;
    if (!raw || raw.schema_version !== 1 || !Array.isArray(raw.enabled_assets)) return undefined;

    const enabledAssets: TaskUsableAssetDetail[] = [];
    for (const item of raw.enabled_assets) {
      if (!item || typeof item !== "object") continue;
      const asset = item as Record<string, unknown>;
      const assetId = text(asset.asset_id);
      const assetType = text(asset.asset_type) as TaskUsableAssetType;
      if (!assetId || !ASSET_TYPES.has(assetType)) continue;
      enabledAssets.push({
        assetId,
        assetType,
        name: text(asset.name) || assetId,
        sourceTaskId: text(asset.source_task_id),
      });
    }

    const taskKind = raw.task_kind === "feature" || raw.task_kind === "bug"
      ? raw.task_kind
      : undefined;
    return {
      taskKind,
      projectKey: text(raw.project_key),
      enabledAssets,
    };
  } catch {
    return undefined;
  }
}

export function toTaskDetail(task: TaskEntity): TaskDetail {
  return {
    id: task.task_id,
    name: task.title,
    description: task.description ?? undefined,
    assetUsage: parseTaskAssetUsage(task.metadata_json),
  };
}
