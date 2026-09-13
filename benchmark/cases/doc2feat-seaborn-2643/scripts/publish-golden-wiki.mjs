import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const caseRoot = resolve(here, '..');
const repoRoot = resolve(caseRoot, '../../..');
const runtimeDir = resolve(caseRoot, 'artifacts/runs/golden');
const workspace = resolve(caseRoot, 'workspaces/golden-local');
const panelBase = process.env.TDAI_PANEL_URL ?? 'http://127.0.0.1:8125/api/v1/knowledge';
const coreBase = process.env.TDAI_CORE_URL ?? 'http://127.0.0.1:8420/v3/meta';
const wikiName = 'Seaborn 项目 Wiki';

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
    throw new Error(`${action} 失败：${envelope.message ?? response.statusText}`);
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
      item.item_id === 'wiki-2643' ? { ...item, ...patch } : item
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

const teamAssets = await post(panelBase, 'wiki/team-assets', { team_id: context.team_id });
const existingWikiId = deposition.merge_items.find((item) => item.item_id === 'wiki-2643')?.target_asset_id;
let wiki = (teamAssets.items ?? []).find((item) => (
  item.knowledge_id === existingWikiId || item.wiki_id === existingWikiId || item.name === wikiName
));
if (!wiki) {
  wiki = await post(panelBase, 'wiki/create', { team_id: context.team_id, name: wikiName });
  console.log(`已创建独立验证 Wiki：${wiki.wiki_id}`);
} else {
  wiki.wiki_id = wiki.knowledge_id ?? wiki.wiki_id;
  console.log(`复用独立验证 Wiki：${wiki.wiki_id}`);
}

const sourcePaths = [
  'doc/api.rst',
  'doc/releases/v0.11.2.txt',
  'doc/docstrings/move_legend.ipynb',
];
const files = await Promise.all(sourcePaths.map(async (path) => {
  const original = await readFile(resolve(workspace, path), 'utf8');
  const flatName = path.replaceAll('/', '__');
  if (path.endsWith('.rst')) {
    return {
      filename: `${flatName}.md`,
      content: `# Seaborn API 文档源\n\n来源：\`${path}\`\n\n\`\`\`rst\n${original}\n\`\`\`\n`,
    };
  }
  if (path.endsWith('.ipynb')) {
    const notebook = JSON.parse(original);
    const body = (notebook.cells ?? []).map((cell, index) => {
      const text = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '');
      return cell.cell_type === 'code'
        ? `## 代码单元 ${index + 1}\n\n\`\`\`python\n${text}\n\`\`\``
        : text;
    }).join('\n\n');
    return {
      filename: `${flatName}.md`,
      content: `# move_legend 示例文档\n\n来源：\`${path}\`\n\n${body}\n`,
    };
  }
  // KnowledgeService 当前只摄取 .md/.txt，且 raw/write 不会为 filename 创建中间目录。
  return { filename: flatName, content: original };
}));
await post(panelBase, 'wiki/raw/write', {
  team_id: context.team_id,
  wiki_id: wiki.wiki_id,
  files,
});
console.log(`已上传 ${files.length} 份 Golden 文档源文件。`);

await updateTaskMergeItem({
  target_asset_id: wiki.wiki_id,
  target_name: '项目 Wiki',
  baseline_version: wiki.version ?? '1',
  status: 'publishing',
  error: undefined,
});

try {
  await post(panelBase, 'wiki/ingest', { wiki_id: wiki.wiki_id });
} catch (error) {
  if (!String(error).includes('409') && !String(error).toLowerCase().includes('busy')) throw error;
}

let detail = wiki;
for (let attempt = 1; attempt <= 180; attempt += 1) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt === 1 ? 800 : 2000));
  detail = await post(panelBase, 'wiki/get', { wiki_id: wiki.wiki_id });
  console.log(`Wiki ingest ${attempt}/180：${detail.status}${detail.internal_status ? ` / ${detail.internal_status}` : ''}`);
  if (detail.status === 'ready' || detail.status === 'failed') break;
}

if (detail.status !== 'ready') {
  const reason = detail.sync_error ?? `Wiki ingest 未完成，当前状态：${detail.status}`;
  await updateTaskMergeItem({ status: 'failed', error: reason });
  throw new Error(reason);
}

await updateTaskMergeItem({
  status: 'merged',
  result_version: detail.version ?? '1',
  contribution: await (async () => {
    const pageList = await post(panelBase, 'wiki/page/ls', { wiki_id: wiki.wiki_id });
    const refs = (pageList.items ?? []).map((page) => page.id ?? page.path).filter(Boolean);
    const pages = [];
    for (let offset = 0; offset < refs.length; offset += 20) {
      const pageRead = await post(panelBase, 'wiki/page/read', {
        wiki_id: wiki.wiki_id,
        refs: refs.slice(offset, offset + 20),
      });
      pages.push(...(pageRead.items ?? []));
    }
    const patchText = await readFile(resolve(runtimeDir, 'change.patch'), 'utf8');
    const featureSymbols = [...patchText.matchAll(/^\+\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm)]
      .map((match) => match[1])
      .filter((name) => !name.startsWith('test_'));
    const wikiPageRefs = pages
      .filter((page) => featureSymbols.some((symbol) => String(page.content ?? '').includes(symbol)))
      .map((page) => page.ref);
    return { source_paths: sourcePaths, wiki_page_refs: wikiPageRefs };
  })(),
  error: undefined,
});
console.log(JSON.stringify({
  task_id: context.task_id,
  wiki_id: wiki.wiki_id,
  status: detail.status,
  page_count: detail.page_count,
  source_files: sourcePaths,
}, null, 2));
