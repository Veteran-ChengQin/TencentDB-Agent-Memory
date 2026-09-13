import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const caseRoot = resolve(here, '..');
const repoRoot = resolve(caseRoot, '../../..');
const runtimeDir = resolve(process.env.DOC2FEAT_RUNTIME_DIR ?? resolve(caseRoot, 'artifacts/runtime'));
const runtimeFromCase = relative(caseRoot, runtimeDir);
if (
  runtimeFromCase === '..'
  || runtimeFromCase.startsWith(`..${sep}`)
  || isAbsolute(runtimeFromCase)
) {
  throw new Error(
    `DOC2FEAT_RUNTIME_DIR 必须位于当前 case 目录内。实际解析为：${runtimeDir}`,
  );
}
const runKind = process.env.DOC2FEAT_RUN_KIND?.trim() ?? 'codebuddy';
const runLabel = process.env.DOC2FEAT_RUN_LABEL?.trim() ?? (runKind === 'golden' ? 'Golden Patch 链路验证' : '');
const isGoldenRun = runKind === 'golden';
const harnessName = runKind === 'codex' ? 'Codex' : 'CodeBuddy';
const coreBase = process.env.TDAI_CORE_URL ?? 'http://127.0.0.1:8420/v3/meta';
const instanceId = process.env.TDAI_INSTANCE_ID ?? 'default';

async function loadUserKey() {
  if (process.env.TDAI_USER_KEY) return process.env.TDAI_USER_KEY.trim();
  return (await readFile(resolve(repoRoot, 'deploy/global-images/.admin-key'), 'utf8')).trim();
}

const userKey = await loadUserKey();
const commonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'x-tdai-service-id': instanceId,
};

async function post(action, body, { authenticate = true } = {}) {
  const response = await fetch(`${coreBase}/${action}`, {
    method: 'POST',
    headers: authenticate ? { ...commonHeaders, 'x-tdai-user-key': userKey } : commonHeaders,
    body: JSON.stringify(body),
  });
  const envelope = await response.json();
  if (!response.ok || envelope.code !== 0) {
    throw new Error(`${action} 失败：${envelope.message ?? response.statusText}`);
  }
  return envelope.data;
}

const auth = await post('auth/verify', { user_key: userKey }, { authenticate: false });
if (!auth.valid || !auth.user?.user_id) throw new Error('TDAI user_key 无效。');
const userId = auth.user.user_id;

const teamIdFromEnv = process.env.TDAI_TEAM_ID?.trim();
const teams = await post('team/list', { user_id: userId, limit: 100, offset: 0 });
const team = teamIdFromEnv
  ? teams.items.find((item) => item.team_id === teamIdFromEnv)
  : teams.items.find((item) => item.name === 'default-team') ?? teams.items[0];
if (!team) throw new Error('当前用户没有可用团队，请先在 Hub 中创建团队。');

const agentName = process.env.TDAI_AGENT_NAME
  ?? (isGoldenRun ? 'Golden-Patch-链路验证器' : `${harnessName}-Doc2Feat-2643`);
const agents = await post('agent/list', { team_id: team.team_id, limit: 100, offset: 0 });
let agent = agents.items.find((item) => item.name === agentName && item.status === 'active');
if (!agent) {
  agent = await post('agent/create', {
    team_id: team.team_id,
    owner_user_id: userId,
    name: agentName,
    description: isGoldenRun
      ? '使用 Doc2Feat Golden Patch 验证 Task 资产采集、门禁和合并计划链路。'
      : `使用 ${harnessName} 完成文档驱动 Feature 开发，并在完成后沉淀研发资产。`,
    prompt: isGoldenRun
      ? '你是仅用于校验资产管理链路的 Golden Patch 验证器，不将参考答案提取为 Skill。'
      : '你是团队中的功能开发 Agent。先理解文档行为，再实现、测试并保留可验证证据；优先利用分配给你的团队资产。',
    metadata_json: JSON.stringify({ ui: { role_prompt: isGoldenRun ? 'Golden Patch 链路验证' : `${harnessName} 文档驱动 Feature 开发`, rules_prompt: '修改前定位公开 API、图例宿主和兼容性约束；修改后运行 F2P 与回归测试。' } }),
  });
}

const instruction = await readFile(resolve(caseRoot, 'instruction.zh-CN.md'), 'utf8');
const title = `Doc2Feat #2643：为 Seaborn 实现 move_legend${runLabel ? `（${runLabel}）` : ''}`;

const tasks = await post('task/list', { team_id: team.team_id, limit: 100, offset: 0 });
let task = tasks.items.find((item) => item.source_url === 'https://github.com/mwaskom/seaborn/pull/2643' && item.title === title);
if (!task) {
  task = await post('task/create', {
    team_id: team.team_id,
    creator_user_id: userId,
    title,
    description: instruction,
    source_type: 'github',
    source_url: 'https://github.com/mwaskom/seaborn/pull/2643',
    status: 'running',
    risk_level: 'low',
    metadata_json: JSON.stringify({
      ui: { participants: [userId] },
      benchmark: { name: 'Doc2Feat-Bench', instance_id: 'mwaskom__seaborn-2643' },
      experiment: { run_label: runLabel, run_kind: runKind },
    }),
    linked_agents: [{ agent_id: agent.agent_id, role_in_task: '功能开发' }],
  });
}

const context = {
  instance_id: instanceId,
  team_id: team.team_id,
  agent_id: agent.agent_id,
  task_id: task.task_id,
  user_id: userId,
  agent_name: agent.name,
  task_title: task.title,
  run_label: runLabel,
  run_kind: runKind,
  runtime_dir: runtimeDir,
};
await mkdir(runtimeDir, { recursive: true });
await writeFile(resolve(runtimeDir, 'tdai-context.json'), `${JSON.stringify(context, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(context, null, 2));
