import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const caseRoot = resolve(here, '..');
const repoRoot = resolve(caseRoot, '../../..');
const runtimeDir = resolve(caseRoot, 'artifacts/runs/golden');
const panelBase = process.env.TDAI_PANEL_URL ?? 'http://127.0.0.1:8125/api/v1/knowledge';
const coreBase = process.env.TDAI_CORE_URL ?? 'http://127.0.0.1:8420/v3/meta';
const context = JSON.parse(await readFile(resolve(runtimeDir, 'tdai-context.json'), 'utf8'));
const deposition = JSON.parse(await readFile(resolve(runtimeDir, 'asset-package.zh-CN.json'), 'utf8'));
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
  if (!response.ok || envelope.code !== 0) throw new Error(`${action} 失败：${envelope.message ?? response.statusText}`);
  return envelope.data;
}

function requireValue(condition, message) {
  if (!condition) throw new Error(`链路校验失败：${message}`);
}

const wikiItem = deposition.merge_items.find((item) => item.item_id === 'wiki-2643');
const ckgItem = deposition.merge_items.find((item) => item.item_id === 'ckg-2643');
requireValue(wikiItem?.status === 'merged' && wikiItem.target_asset_id, 'Wiki 未处于已合并状态');
requireValue(ckgItem?.status === 'merged' && ckgItem.target_asset_id, 'CKG 未处于已合并状态');

const [task, participation, rawFiles, wikiPages, wikiSearch, ckg, ckgSearch] = await Promise.all([
  post(coreBase, 'task/get', { task_id: context.task_id }),
  post(coreBase, 'participation-log/list', { team_id: context.team_id, task_id: context.task_id, limit: 100, offset: 0 }),
  post(panelBase, 'wiki/raw/ls', { wiki_id: wikiItem.target_asset_id }),
  post(panelBase, 'wiki/page/ls', { wiki_id: wikiItem.target_asset_id }),
  post(panelBase, 'wiki/search', { wiki_id: wikiItem.target_asset_id, query: 'move_legend', limit: 10 }),
  post(panelBase, 'code-graph/get', { code_graph_id: ckgItem.target_asset_id }),
  post(panelBase, 'code-graph/search', { code_graph_id: ckgItem.target_asset_id, query: 'move_legend', limit: 10 }),
]);

const taskMetadata = JSON.parse(task.metadata_json || '{}');
const persistedStatuses = Object.fromEntries(
  (taskMetadata.asset_deposition?.merge_items ?? []).map((item) => [item.asset_type, item.status]),
);
const rawNames = (rawFiles.items ?? []).map((item) => item.filename);
const wikiHits = wikiSearch.results ?? [];
const wikiPageItems = wikiPages.items ?? [];
const firstWikiPage = wikiPageItems[0]
  ? await post(panelBase, 'wiki/page/read', { wiki_id: wikiItem.target_asset_id, refs: [wikiPageItems[0].path] })
  : { items: [] };
const ckgText = ckgSearch.text ?? '';

requireValue(task.status === 'completed', 'Golden Task 未完成');
requireValue(participation.total >= 1, 'Task 没有参与记录');
requireValue(rawNames.length === 3, `Wiki 原始源文件数量不是 3：${JSON.stringify(rawFiles)}`);
requireValue(wikiHits.length > 0, 'Wiki 无法检索 move_legend');
requireValue(wikiPageItems.length > 0 && firstWikiPage.items?.[0]?.content, 'Wiki 页面内容无法读取');
requireValue(ckg.status === 'ready', 'CKG 未 ready');
requireValue(ckgText.toLowerCase().includes('move_legend'), 'CKG 无法检索 move_legend');
requireValue(persistedStatuses.task_bundle === 'saved', 'Task 证据包未保存');
requireValue(persistedStatuses.llm_wiki === 'merged', 'Task 元数据中的 Wiki 状态未合并');
requireValue(persistedStatuses.code_graph === 'merged', 'Task 元数据中的 CKG 状态未合并');
requireValue(persistedStatuses.skill === 'skipped', 'Golden Skill 应被防泄漏规则跳过');

console.log(JSON.stringify({
  task: { task_id: task.task_id, status: task.status, participation_count: participation.total },
  task_asset_statuses: persistedStatuses,
  wiki: { wiki_id: wikiItem.target_asset_id, raw_files: rawNames.length, pages: wikiPageItems.length, search_hits: wikiHits.length, page_preview_readable: true },
  code_graph: {
    code_graph_id: ckgItem.target_asset_id,
    status: ckg.status,
    commit_hash: ckg.commit_hash,
    stats: ckg.stats,
    search_contains_move_legend: true,
  },
}, null, 2));
