import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const caseRoot = resolve(here, '..');
const repoRoot = resolve(caseRoot, '../../..');
const runtimeDir = resolve(process.env.DOC2FEAT_RUNTIME_DIR ?? resolve(caseRoot, 'artifacts/runs/golden'));
const panelBase = process.env.TDAI_PANEL_URL ?? 'http://127.0.0.1:8125/api/v1/knowledge';
const coreBase = process.env.TDAI_CORE_URL ?? 'http://127.0.0.1:8420/v3/meta';

const context = JSON.parse(await readFile(resolve(runtimeDir, 'tdai-context.json'), 'utf8'));
const packagePath = resolve(runtimeDir, 'asset-package.zh-CN.json');
const deposition = JSON.parse(await readFile(packagePath, 'utf8'));
const patchText = await readFile(resolve(runtimeDir, 'change.patch'), 'utf8');
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

function extractCodeEntities(text) {
  const entities = [];
  let currentPath = '';
  for (const line of text.split(/\r?\n/)) {
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (fileMatch) {
      currentPath = fileMatch[2];
      continue;
    }
    const entityMatch = line.match(/^\+\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/);
    if (!entityMatch || !currentPath) continue;
    entities.push({ name: entityMatch[2], kind: entityMatch[1] === 'class' ? 'class' : 'function', path: currentPath });
  }
  return entities.filter((entity, index) => (
    entities.findIndex((candidate) => candidate.name === entity.name && candidate.path === entity.path) === index
  ));
}

const codeEntities = extractCodeEntities(patchText);
const featureSymbols = codeEntities.map((entity) => entity.name).filter((name) => !name.startsWith('test_'));
const wikiItem = deposition.merge_items.find((item) => item.asset_type === 'llm_wiki');
let wikiPageRefs = [];
if (wikiItem?.target_asset_id) {
  const pageList = await post(panelBase, 'wiki/page/ls', { wiki_id: wikiItem.target_asset_id });
  const refs = (pageList.items ?? []).map((page) => page.id ?? page.path).filter(Boolean);
  const pages = [];
  for (let offset = 0; offset < refs.length; offset += 20) {
    const pageRead = await post(panelBase, 'wiki/page/read', {
      wiki_id: wikiItem.target_asset_id,
      refs: refs.slice(offset, offset + 20),
    });
    pages.push(...(pageRead.items ?? []));
  }
  wikiPageRefs = pages
    .filter((page) => featureSymbols.some((symbol) => String(page.content ?? '').includes(symbol)))
    .map((page) => page.ref);
}

const nextDeposition = {
  ...deposition,
  merge_items: deposition.merge_items.map((item) => {
    if (item.asset_type === 'llm_wiki') {
      return { ...item, contribution: { source_paths: item.source_items, wiki_page_refs: wikiPageRefs } };
    }
    if (item.asset_type === 'code_graph') {
      return { ...item, contribution: { source_paths: item.source_items, code_entities: codeEntities } };
    }
    return item;
  }),
  updated_at: new Date().toISOString(),
};

await writeFile(packagePath, `${JSON.stringify(nextDeposition, null, 2)}\n`, 'utf8');
const task = await post(coreBase, 'task/get', { task_id: context.task_id });
const metadata = JSON.parse(task.metadata_json || '{}');
metadata.asset_deposition = nextDeposition;
await post(coreBase, 'task/update', { task_id: context.task_id, metadata_json: JSON.stringify(metadata) });

console.log(JSON.stringify({
  task_id: context.task_id,
  wiki_contribution_pages: wikiPageRefs.length,
  code_contribution_entities: codeEntities.length,
  code_entities: codeEntities,
}, null, 2));
