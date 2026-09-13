import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const caseRoot = resolve(here, '..');
const repoRoot = resolve(caseRoot, '../../..');
const runtimeDir = resolve(caseRoot, 'artifacts/runs/golden');
const panelBase = process.env.TDAI_PANEL_URL ?? 'http://127.0.0.1:8125/api/v1/knowledge';
const coreBase = process.env.TDAI_CORE_URL ?? 'http://127.0.0.1:8420/v3/meta';
const repoUrl = 'https://github.com/mwaskom/seaborn.git';
const releaseTag = 'v0.11.2';
const releaseCommit = '703259f2dca711205f81d2d8f9e3fa45774eb0da';
const graphName = 'Seaborn 项目代码图谱';

const context = JSON.parse(await readFile(resolve(runtimeDir, 'tdai-context.json'), 'utf8'));
const packagePath = resolve(runtimeDir, 'asset-package.zh-CN.json');
const deposition = JSON.parse(await readFile(packagePath, 'utf8'));
const userKey = process.env.TDAI_USER_KEY?.trim()
  || (await readFile(resolve(repoRoot, 'deploy/global-images/.admin-key'), 'utf8')).trim();
const headers = {
  'content-type': 'application/json; charset=utf-8',
  'x-tdai-service-id': context.instance_id,
  'x-tdai-user-key': userKey,
};

async function post(base, action, body) {
  const response = await fetch(`${base}/${action}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const envelope = await response.json();
  if (!response.ok || envelope.code !== 0) {
    const error = new Error(`${action} 失败：${envelope.message ?? response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return envelope.data;
}

async function updateTaskMergeItem(patch) {
  const current = await post(coreBase, 'task/get', { task_id: context.task_id });
  const metadata = JSON.parse(current.metadata_json || '{}');
  const currentDeposition = metadata.asset_deposition ?? deposition;
  const nextDeposition = {
    ...currentDeposition,
    merge_items: currentDeposition.merge_items.map((item) => (
      item.item_id === 'ckg-2643' ? { ...item, ...patch } : item
    )),
    updated_at: new Date().toISOString(),
  };
  metadata.asset_deposition = nextDeposition;
  await post(coreBase, 'task/update', {
    task_id: context.task_id,
    metadata_json: JSON.stringify(metadata),
  });
  await writeFile(packagePath, `${JSON.stringify(nextDeposition, null, 2)}\n`, 'utf8');
}

const listing = await post(panelBase, 'code-graph/list', { team_id: context.team_id, limit: 100, offset: 0 });
const existingGraphId = deposition.merge_items.find((item) => item.item_id === 'ckg-2643')?.target_asset_id;
let graph = (listing.items ?? []).find((item) => (
  item.code_graph_id === existingGraphId || (item.repo_name === graphName && item.branch === releaseTag)
));
if (!graph) {
  graph = await post(panelBase, 'code-graph/create', {
    team_id: context.team_id,
    repo_url: repoUrl,
    branch: releaseTag,
    repo_name: graphName,
  });
  console.log(`已创建独立验证 CKG：${graph.code_graph_id}`);
} else {
  console.log(`复用独立验证 CKG：${graph.code_graph_id}`);
}

await updateTaskMergeItem({
  target_asset_id: graph.code_graph_id,
  target_name: '项目代码图谱',
  baseline_version: graph.version ?? '1',
  expected_commit: releaseCommit,
  status: 'publishing',
  error: undefined,
});

let detail = graph;
for (let attempt = 1; attempt <= 180; attempt += 1) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt === 1 ? 800 : 2000));
  detail = await post(panelBase, 'code-graph/get', { code_graph_id: graph.code_graph_id });
  console.log(`CKG build ${attempt}/180：${detail.status}${detail.commit_hash ? ` / ${detail.commit_hash.slice(0, 10)}` : ''}`);
  if (detail.status === 'ready' || detail.status === 'failed') break;
}

if (detail.status !== 'ready') {
  const reason = detail.sync_error ?? `CKG 构建未完成，当前状态：${detail.status}`;
  await updateTaskMergeItem({ status: 'failed', error: reason });
  throw new Error(reason);
}

// ready callback 会自动登记 meta；这里再做一次幂等 fallback，验证管理链路可查询该资产。
try {
  await post(panelBase, 'code-graph/register-meta', {
    team_id: context.team_id,
    code_graph_id: graph.code_graph_id,
  });
} catch (error) {
  if (error.status !== 409) throw error;
}

const taskChange = await post(panelBase, 'code-graph/task-diff/build', {
  team_id: context.team_id,
  task_id: context.task_id,
  code_graph_id: graph.code_graph_id,
  base_commit: deposition.artifact_bundle.base_commit,
  // The verifier creates a disposable local commit after applying the patch.
  // CKG provenance must use the commit from the indexed project repository.
  result_commit: releaseCommit,
  result_snapshot: deposition.artifact_bundle.result_commit
    ? `workspace-commit:${deposition.artifact_bundle.result_commit}`
    : undefined,
  patch: await readFile(resolve(runtimeDir, 'change.patch'), 'utf8'),
});

await updateTaskMergeItem({
  status: taskChange.status === 'merged' ? 'merged' : 'approved',
  result_version: detail.commit_hash ?? detail.version ?? releaseCommit,
  contribution: {
    source_paths: taskChange.diff.files.map((file) => file.path),
    code_entities: taskChange.diff.entities.map((entity) => ({
      name: entity.name,
      kind: entity.kind,
      path: entity.path,
    })),
  },
  error: undefined,
});
console.log(JSON.stringify({
  task_id: context.task_id,
  code_graph_id: graph.code_graph_id,
  status: detail.status,
  branch: detail.branch,
  commit_hash: detail.commit_hash,
  stats: detail.stats,
  task_change: {
    status: taskChange.status,
    files: taskChange.diff.summary.files,
    entities: taskChange.diff.summary.entities,
    relations: taskChange.diff.summary.relations,
  },
}, null, 2));
