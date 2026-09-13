export interface TaskAssetEvidenceLike {
  execution?: {
    status?: unknown;
  };
  artifact_bundle?: {
    session_ids?: unknown[];
    sessions?: unknown[];
  };
  changed_files?: unknown[];
  verification?: unknown[];
}

/**
 * 只有执行器或通用回写器已经写入可观察结果时，Task 才有可审核的资产。
 * merge_items 可能只是任务启动前准备的模板，不能单独作为资产已产出的证据。
 */
export function hasTaskAssetEvidence(value: TaskAssetEvidenceLike | undefined): boolean {
  if (!value) return false;
  const hasExecutionResult = ['completed', 'failed', 'interrupted'].includes(
    String(value.execution?.status ?? ''),
  );
  return Boolean(
    hasExecutionResult
      || value.artifact_bundle?.session_ids?.length
      || value.artifact_bundle?.sessions?.length
      || value.changed_files?.length
      || value.verification?.length,
  );
}
