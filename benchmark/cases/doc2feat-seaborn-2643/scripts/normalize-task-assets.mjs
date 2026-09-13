import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const caseRoot = resolve(here, '..');
const repoRoot = resolve(caseRoot, '../../..');
const coreBase = process.env.TDAI_CORE_URL ?? 'http://127.0.0.1:8420/v3/meta';
const runNames = ['golden', 'codebuddy-500', 'codex-sol'];
const userKey = process.env.TDAI_USER_KEY?.trim()
  || (await readFile(resolve(repoRoot, 'deploy/global-images/.admin-key'), 'utf8')).trim();

const targetName = {
  task_bundle: '任务证据包',
  llm_wiki: '项目 Wiki',
  code_graph: '项目代码图谱',
  skill: '团队 Skill',
};

function summary(item) {
  const count = item.source_items?.length ?? 0;
  if (item.asset_type === 'task_bundle') return '保存本次任务的会话、实现变更和验证记录。';
  if (item.asset_type === 'llm_wiki') return `从 ${count} 份文档变更生成或更新项目知识。`;
  if (item.asset_type === 'code_graph') return `根据 ${count} 个代码或测试变更更新项目代码图谱。`;
  return '从成功会话中提取可跨任务复用的方法。';
}

async function post(instanceId, action, body) {
  const response = await fetch(`${coreBase}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-tdai-service-id': instanceId,
      'x-tdai-user-key': userKey,
    },
    body: JSON.stringify(body),
  });
  const envelope = await response.json();
  if (!response.ok || envelope.code !== 0) throw new Error(`${action} 失败：${envelope.message ?? response.statusText}`);
  return envelope.data;
}

for (const runName of runNames) {
  const runtimeDir = resolve(caseRoot, `artifacts/runs/${runName}`);
  const context = JSON.parse(await readFile(resolve(runtimeDir, 'tdai-context.json'), 'utf8'));
  const packagePath = resolve(runtimeDir, 'asset-package.zh-CN.json');
  const deposition = JSON.parse(await readFile(packagePath, 'utf8'));
  deposition.merge_items = deposition.merge_items.filter((item) => item.asset_type !== 'task_bundle').map((item) => ({
    ...item,
    target_name: targetName[item.asset_type],
    action_summary: summary(item),
    error: item.asset_type === 'skill' && context.run_kind === 'golden'
      ? '本次运行仅用于验证资产管理链路，未生成 Skill。'
      : item.error,
  }));
  if (context.run_kind === 'golden' && deposition.execution) {
    deposition.execution.summary = '参考实现已应用，资产管理链路验证完成。';
  }
  deposition.updated_at = new Date().toISOString();
  await writeFile(packagePath, `${JSON.stringify(deposition, null, 2)}\n`, 'utf8');

  const task = await post(context.instance_id, 'task/get', { task_id: context.task_id });
  const metadata = JSON.parse(task.metadata_json || '{}');
  metadata.asset_deposition = deposition;
  await post(context.instance_id, 'task/update', {
    task_id: context.task_id,
    metadata_json: JSON.stringify(metadata),
  });
  console.log(`${runName}: ${context.task_id} 已更新`);
}
