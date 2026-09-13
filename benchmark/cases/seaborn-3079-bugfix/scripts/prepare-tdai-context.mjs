import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const caseRoot = resolve(here, '..');
const repoRoot = resolve(caseRoot, '../../..');
const runtimeDir = resolve(process.env.SEABORN_3079_RUNTIME_DIR ?? resolve(caseRoot, 'artifacts/runtime'));
const config = JSON.parse(await readFile(resolve(caseRoot, 'case-config.json'), 'utf8'));
const runKind = process.env.SEABORN_3079_RUN_KIND?.trim() || 'codebuddy';
const taskId = process.env.SEABORN_3079_TASK_ID?.trim() || config.tdai_task_id;
const coreBase = process.env.TDAI_CORE_URL ?? 'http://127.0.0.1:8420/v3/meta';
const instanceId = process.env.TDAI_INSTANCE_ID ?? 'default';
const userKey = process.env.TDAI_USER_KEY?.trim()
  || (await readFile(resolve(repoRoot, 'deploy/global-images/.admin-key'), 'utf8')).trim();
const headers = {
  'content-type': 'application/json; charset=utf-8',
  'x-tdai-service-id': instanceId,
  'x-tdai-user-key': userKey,
};

async function post(action, body, authenticate = true) {
  const response = await fetch(`${coreBase}/${action}`, {
    method: 'POST',
    headers: authenticate ? headers : {
      'content-type': 'application/json; charset=utf-8',
      'x-tdai-service-id': instanceId,
    },
    body: JSON.stringify(body),
  });
  const envelope = await response.json();
  if (!response.ok || envelope.code !== 0) throw new Error(`${action}: ${envelope.message ?? response.statusText}`);
  return envelope.data;
}

const auth = await post('auth/verify', { user_key: userKey }, false);
if (!auth.valid) throw new Error('TDAI user key is invalid.');
const task = await post('task/get', { task_id: taskId });
let taskMetadata = {};
try {
  taskMetadata = JSON.parse(task.metadata_json || '{}');
} catch {
  throw new Error(`Task ${task.task_id} metadata_json is invalid.`);
}
const assetUsage = taskMetadata.asset_usage || {};
const expectedProjectKey = new URL(config.repository).pathname
  .replace(/^\//, '')
  .replace(/\.git$/, '')
  .toLowerCase();
if (task.source_url) {
  if (task.source_url !== config.source_url) {
    throw new Error(`Unexpected Task source: ${task.source_url}`);
  }
} else if (
  assetUsage.project_key?.toLowerCase() !== expectedProjectKey
  || assetUsage.task_kind !== 'bug'
) {
  throw new Error(
    `Manual Task ${task.task_id} must be a bug task in project ${expectedProjectKey}.`,
  );
}

const requestedAgentName = process.env.TDAI_AGENT_NAME?.trim();
let agentId = process.env.SEABORN_3079_AGENT_ID?.trim();
// Keep the old no-argument benchmark command compatible with case-config,
// while allowing demo runs to request a harness-specific Agent by name.
if (!agentId && !requestedAgentName && runKind === 'codebuddy') agentId = config.tdai_agent_id;
if (!agentId) {
  const agentName = requestedAgentName
    || (runKind === 'codex' ? 'Codex-Seaborn-3079' : 'CodeBuddy-Seaborn-3079');
  const agents = await post('agent/list', { team_id: task.team_id, limit: 100, offset: 0 });
  let agent = agents.items.find((item) => item.name === agentName && item.status === 'active');
  if (!agent) {
    const harnessName = runKind === 'codex' ? 'Codex' : 'CodeBuddy';
    agent = await post('agent/create', {
      team_id: task.team_id,
      owner_user_id: auth.user.user_id,
      name: agentName,
      description: `使用 ${harnessName} 修复已关联历史 Feature 资产的 Bug Task。`,
      prompt: '你是团队中的缺陷修复 Agent。先核对任务关联的历史资产，再定位根因、完成最小修复并运行回归测试。',
      metadata_json: JSON.stringify({
        ui: {
          role_prompt: `${harnessName} Bug 修复`,
          rules_prompt: '先读取任务已分配资产；修改后运行 F2P 与回归测试并保留证据。',
        },
      }),
    });
  }
  agentId = agent.agent_id;
}

const links = await post('task-agent/list', { task_id: task.task_id, limit: 100, offset: 0 });
if (!links.items.some((item) => item.agent_id === agentId && item.status === 'active')) {
  await post('task-agent/link', {
    task_id: task.task_id,
    agent_id: agentId,
    role_in_task: 'Bug 修复执行 Agent',
  });
}

const context = {
  instance_id: instanceId,
  team_id: task.team_id,
  agent_id: agentId,
  task_id: task.task_id,
  user_id: auth.user.user_id,
  task_title: task.title,
  model: config.model,
  max_turns: config.max_turns,
  run_kind: runKind,
};
await mkdir(runtimeDir, { recursive: true });
await writeFile(resolve(runtimeDir, 'tdai-context.json'), `${JSON.stringify(context, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(context, null, 2));
