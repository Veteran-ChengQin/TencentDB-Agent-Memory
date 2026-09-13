import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Segment, Tag, Text } from 'tea-component';
import {
  deriveTaskProjectKey,
  findRelatedFeatureTasks,
  type RelatedTaskCandidate,
  type RelatedTaskEvidence,
  type Task,
  type TaskAssetUsage,
  type TaskKind,
  type TaskUsableAsset,
} from '@/services';
import { tea } from '@/lib/tea-bridge';

const ASSET_LABELS: Record<TaskUsableAsset['asset_type'], string> = {
  llm_wiki: '项目 Wiki',
  code_graph: '项目代码图谱',
  skill: '团队 Skill',
  chat_memory: 'Chat Memory',
};

function evidenceText(evidence: RelatedTaskEvidence): string {
  switch (evidence.type) {
    case 'same_project': return `同一项目：${evidence.value ?? ''}`;
    case 'exact_entity': return `命中代码实体：${evidence.value ?? ''}`;
    case 'same_file': return `命中变更文件：${evidence.value ?? ''}`;
    case 'bm25': return `BM25 文本相关：${evidence.value ?? ''}`;
  }
}

function initialUsage(task: Task, projectKey: string): TaskAssetUsage {
  return task.asset_usage ?? {
    schema_version: 1,
    project_key: projectKey,
    search: { status: 'idle', candidates: [] },
    related_tasks: [],
    enabled_assets: [],
    updated_at: new Date().toISOString(),
  };
}

function assetKey(asset: TaskUsableAsset): string {
  return `${asset.asset_type}:${asset.asset_id}`;
}

export default function TaskAssetUsagePanel({
  task,
  canEdit,
  onChange,
}: {
  task: Task;
  canEdit: boolean;
  onChange: (usage: TaskAssetUsage) => Promise<void>;
}) {
  const inferredProject = deriveTaskProjectKey(task);
  const [projectKey, setProjectKey] = useState(task.asset_usage?.project_key || inferredProject);
  const [saving, setSaving] = useState(false);
  const [searching, setSearching] = useState(false);
  const [selectedAssets, setSelectedAssets] = useState<Record<string, Set<string>>>({});

  useEffect(() => {
    setProjectKey(task.asset_usage?.project_key || deriveTaskProjectKey(task));
  }, [task.task_id, task.asset_usage?.project_key, task.source_url, task.asset_deposition]);

  const candidates = useMemo(
    () => task.asset_usage?.search?.candidates ?? [],
    [task.asset_usage?.search?.candidates],
  );
  const confirmed = task.asset_usage?.related_tasks?.[0];

  useEffect(() => {
    const next: Record<string, Set<string>> = {};
    for (const candidate of candidates) {
      next[candidate.task_id] = new Set(candidate.available_assets.map(assetKey));
    }
    setSelectedAssets(next);
  }, [task.task_id, candidates]);

  const confirmedAssets = useMemo(
    () => task.asset_usage?.enabled_assets ?? [],
    [task.asset_usage?.enabled_assets],
  );

  async function persist(patch: Partial<TaskAssetUsage>) {
    const base = initialUsage(task, projectKey.trim());
    const next: TaskAssetUsage = {
      ...base,
      ...patch,
      project_key: patch.project_key ?? base.project_key,
      search: patch.search ?? base.search ?? { status: 'idle', candidates: [] },
      related_tasks: patch.related_tasks ?? base.related_tasks,
      enabled_assets: patch.enabled_assets ?? base.enabled_assets,
      updated_at: new Date().toISOString(),
    };
    setSaving(true);
    try {
      await onChange(next);
    } finally {
      setSaving(false);
    }
  }

  async function changeKind(kind: TaskKind) {
    const changingAwayFromBug = kind === 'feature' && task.asset_usage?.task_kind === 'bug';
    try {
      await persist({
        task_kind: kind,
        project_key: projectKey.trim(),
        ...(changingAwayFromBug
          ? {
              search: { status: 'idle', candidates: [] },
              related_tasks: [],
              enabled_assets: [],
            }
          : {}),
      });
    } catch (error) {
      tea.notify.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveProject() {
    const value = projectKey.trim().toLowerCase();
    if (!value) {
      tea.notify.warning('请填写项目标识，例如组织名/项目名。');
      return;
    }
    setProjectKey(value);
    try {
      const projectChanged = value !== (task.asset_usage?.project_key ?? '').trim().toLowerCase();
      await persist({
        project_key: value,
        ...(projectChanged
          ? {
              search: { status: 'idle', candidates: [] },
              related_tasks: [],
              enabled_assets: [],
            }
          : {}),
      });
      tea.notify.success('项目标识已保存。');
    } catch (error) {
      tea.notify.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function search() {
    const value = projectKey.trim().toLowerCase();
    if (!value) {
      tea.notify.warning('请先填写并保存项目标识。');
      return;
    }
    setSearching(true);
    try {
      const results = await findRelatedFeatureTasks(task, value);
      await persist({
        task_kind: 'bug',
        project_key: value,
        search: {
          status: 'completed',
          searched_at: new Date().toISOString(),
          candidates: results,
        },
      });
      if (results.length === 0) tea.notify.info('没有找到可关联的历史 Feature Task。');
    } catch (error) {
      tea.notify.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSearching(false);
    }
  }

  function toggleAsset(candidate: RelatedTaskCandidate, asset: TaskUsableAsset) {
    const key = assetKey(asset);
    setSelectedAssets((current) => {
      const selected = new Set(current[candidate.task_id] ?? []);
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      return { ...current, [candidate.task_id]: selected };
    });
  }

  async function confirmCandidate(candidate: RelatedTaskCandidate) {
    const selected = selectedAssets[candidate.task_id] ?? new Set<string>();
    const assets = candidate.available_assets.filter((asset) => selected.has(assetKey(asset)));
    if (assets.length === 0) {
      tea.notify.warning('请至少选择一项可用资产。');
      return;
    }
    try {
      await persist({
        related_tasks: [{
          task_id: candidate.task_id,
          title: candidate.title,
          relation: candidate.relation,
          status: 'confirmed',
          evidence: candidate.evidence,
        }],
        enabled_assets: assets,
      });
      tea.notify.success('历史任务及资产已关联到当前 Task。');
    } catch (error) {
      tea.notify.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function clearRelation() {
    try {
      await persist({ related_tasks: [], enabled_assets: [] });
    } catch (error) {
      tea.notify.error(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className="_memory-task-asset-usage">
      <div className="_memory-task-asset-usage-head">
        <div>
          <div className="_memory-task-asset-usage-title">任务类型与历史资产</div>
          <Text theme="weak">为当前任务确定资产范围，不会修改 Agent 的固定资产。</Text>
        </div>
        {confirmed && <Tag theme="success">已关联</Tag>}
      </div>

      <div className="_memory-task-asset-setting-row">
        <span className="_memory-task-asset-label">任务类型</span>
        <Segment
          value={task.asset_usage?.task_kind ?? ''}
          disabled={!canEdit || saving}
          onChange={(value) => void changeKind(value as TaskKind)}
          options={[
            { value: 'feature', text: 'Feature 开发' },
            { value: 'bug', text: 'Bug 修复' },
          ]}
        />
      </div>

      <div className="_memory-task-asset-setting-row">
        <span className="_memory-task-asset-label">所属项目</span>
        <Input
          value={projectKey}
          onChange={setProjectKey}
          disabled={!canEdit}
          placeholder="例如组织名/项目名"
          className="_memory-task-project-input"
        />
        <Button disabled={!canEdit || saving} onClick={() => void saveProject()}>保存</Button>
      </div>

      {task.asset_usage?.task_kind === 'feature' && (
        <div className="_memory-task-asset-tip">
          该任务完成并沉淀资产后，可被同项目的 Bug Task 主动发现。
        </div>
      )}

      {task.asset_usage?.task_kind === 'bug' && (
        <>
          <div className="_memory-task-asset-actions">
            <Button
              type="primary"
              disabled={!canEdit || saving || !projectKey.trim()}
              loading={searching}
              onClick={() => void search()}
            >
              查找相关历史任务
            </Button>
          </div>

          {confirmed ? (
            <div className="_memory-related-task-confirmed">
              <div className="_memory-related-task-title">{confirmed.title}</div>
              <div className="_memory-related-task-evidence">
                {confirmed.evidence.map((item, index) => (
                  <span key={`${item.type}-${index}`}>✓ {evidenceText(item)}</span>
                ))}
              </div>
              <div className="_memory-task-enabled-assets">
                {confirmedAssets.map((asset) => (
                  <span key={assetKey(asset)}>{ASSET_LABELS[asset.asset_type]} · {asset.name}</span>
                ))}
              </div>
              {canEdit && <Button type="link" onClick={() => void clearRelation()}>解除关联</Button>}
            </div>
          ) : candidates.length > 0 ? (
            <div className="_memory-related-task-list">
              {candidates.map((candidate) => (
                <div className="_memory-related-task-card" key={candidate.task_id}>
                  <div className="_memory-related-task-card-head">
                    <div className="_memory-related-task-title">{candidate.title}</div>
                    <Tag theme={candidate.confidence === 'high' ? 'success' : 'warning'}>
                      相关度：{candidate.confidence === 'high' ? '高' : '中'}
                    </Tag>
                  </div>
                  <div className="_memory-related-task-evidence">
                    {candidate.evidence.map((item, index) => (
                      <span key={`${item.type}-${index}`}>✓ {evidenceText(item)}</span>
                    ))}
                  </div>
                  <div className="_memory-related-task-assets">
                    {candidate.available_assets.map((asset) => (
                      <label key={assetKey(asset)}>
                        <input
                          type="checkbox"
                          checked={selectedAssets[candidate.task_id]?.has(assetKey(asset)) ?? false}
                          onChange={() => toggleAsset(candidate, asset)}
                          disabled={!canEdit}
                        />
                        <span>{ASSET_LABELS[asset.asset_type]} · {asset.name}</span>
                      </label>
                    ))}
                  </div>
                  <Button
                    type="primary"
                    disabled={!canEdit || saving}
                    onClick={() => void confirmCandidate(candidate)}
                  >
                    确认关联
                  </Button>
                </div>
              ))}
            </div>
          ) : task.asset_usage?.search?.status === 'completed' ? (
            <div className="_memory-task-asset-empty">没有找到满足条件的历史 Feature Task。</div>
          ) : null}
        </>
      )}
    </section>
  );
}
