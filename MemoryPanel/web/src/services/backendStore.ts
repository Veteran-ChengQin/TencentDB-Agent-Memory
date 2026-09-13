/**
 * backendStore.ts — Team / Agent / Task 的后端数据层（链路 A）。
 *
 * 取代原来 demoStore.ts 里 team/agent/task 相关的 localStorage 实现：
 *   - Team    走 teamApi.teamsApi + teamApi.membersApi
 *   - Agent   走 teamApi.agentsApi
 *   - Task    走 teamApi.tasksApi
 *
 * 后端 schema 里没有的 UI 专属字段（icon / accent / role_prompt / rules_prompt /
 * skills / code_graphs / llm_wikis / chat_memories / task.participants 等）
 * 统一序列化进 agent.metadata_json / task.metadata_json 的 "ui" namespace，
 * 保证刷新页面后这些字段不丢 —— 等对应的资产/字段在后端落地后，把
 * readXxxUiMeta / writeXxxUiMeta 里的读写目标换成真字段即可，组件层不用改。
 *
 * 缓存策略：
 *   - 模块级缓存 + in-flight promise 去重：同一时刻多个 useTeams()/useAgents() 只发一次请求；
 *   - invalidateBackendCache()：所有写操作后调用，清缓存并广播 BACKEND_REFRESH_EVENT；
 *   - useTeams/useAgents/useTasks 监听该事件自动重新拉取。
 */

import {
  tasksApi,
  type Team as BackendTeam,
  type Agent as BackendAgent,
  type TeamMember as BackendMember,
  type BackendTask,
} from '@/lib/teamApi';
import { invalidateBackendCache, updateCachedTask } from '@/stores/backend';
import { hasTaskAssetEvidence } from './task-asset-evidence';

// ========================= Types（前端展示形状，尽量贴近旧 demoStore，减少调用方改动） =========================

export interface TeamMember {
  user_id: string;
  role: 'admin' | 'member' | 'reviewer';
  joined_at_ms: number;
  username?: string;
}

export interface Team {
  team_id: string;
  name: string;
  description: string;
  owner_user_id: string;
  created_at_ms: number;
  members: TeamMember[];
}

export interface Agent {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
  description: string;
  role_prompt: string;
  rules_prompt: string;
  icon: string;
  accent: 'blue' | 'purple' | 'orange' | 'emerald' | 'rose' | 'slate';
  skills: string[];
  code_graphs: string[];
  llm_wikis: string[];
  chat_memories: string[];
  /** 后端 metadata_json 透传（写回时需要在旧值基础上 merge，而不是整体覆盖） */
  metadata_json?: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export type TaskStatus = 'running' | 'completed';
export type TaskSourceType = 'manual' | 'tapd' | 'github' | 'other';

export type AssetDepositionStatus =
  | 'saved'
  | 'pending_review'
  | 'approved'
  | 'publishing'
  | 'merged'
  | 'blocked'
  | 'conflict'
  | 'failed'
  | 'skipped';

export type ChangedFileCategory = 'code' | 'document' | 'test' | 'config' | 'other';

export interface TaskChangedFile {
  path: string;
  category: ChangedFileCategory;
  operation: 'added' | 'modified' | 'deleted' | 'renamed';
  additions?: number;
  deletions?: number;
  /** 仅包含当前文件的 unified diff。 */
  diff?: string;
  /**
   * 任务完成时的文本文件全文。需要发布到 Wiki 的文档必须保留该字段；diff
   * 只用于审阅，不能作为 Wiki 的源文档。
   */
  content?: string;
}

export interface TaskVerificationCase {
  node_id: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  duration_ms?: number;
  detail?: string;
}

export interface TaskVerification {
  command: string;
  passed: number;
  failed: number;
  skipped?: number;
  status: 'passed' | 'failed' | 'not_run';
  result_uri?: string;
  tests?: TaskVerificationCase[];
}

export interface TaskSessionMessage {
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system';
  content: string;
  tool_name?: string;
  tool_call_id?: string;
  timestamp?: string;
  status?: string;
  truncated?: boolean;
  original_chars?: number;
}

/** Agent 无关的会话形状：既用于任务详情展示，也可直接转换成 Skill 提取输入。 */
export interface TaskSessionTrace {
  schema_version: 1;
  session_id: string;
  harness: string;
  model?: string;
  source_format: 'codex-jsonl' | 'codebuddy-jsonl' | string;
  started_at?: string;
  finished_at?: string;
  outcome?: string;
  turns?: number;
  event_count: number;
  message_count: number;
  tools: string[];
  messages: TaskSessionMessage[];
}

export interface AssetContribution {
  /** 本次 Task 提交给目标资产的原始文件。 */
  source_paths?: string[];
  /** Wiki 合并后可归因于本次 Task 的页面 ref（与 wiki/graph node id 一致）。 */
  wiki_page_refs?: string[];
  /** CKG 合并后可归因于本次 Task 的代码实体。 */
  code_entities?: Array<{
    name: string;
    kind?: 'function' | 'method' | 'class' | 'interface' | 'type' | 'variable' | 'route' | 'component';
    path?: string;
  }>;
  /** 本次 Task 的会话实际生成或更新的 Skill。 */
  skill_ids?: string[];
  /** Skill ID 到实际名称的映射；任务级按需加载使用名称调用 skill_view。 */
  skill_names?: Record<string, string>;
}

export interface SkillExtractionReceipt {
  /** `/skill/extract` 返回的异步归档任务 ID。 */
  archive_task_id: string;
  agent_id: string;
  requested_at: string;
  /** 提取前该 Agent 的 Skill 版本，用于识别被更新的已有 Skill。 */
  baseline_versions: Record<string, number>;
}

export interface AssetMergeItem {
  item_id: string;
  asset_type: 'task_bundle' | 'llm_wiki' | 'code_graph' | 'skill';
  target_asset_id?: string;
  target_name: string;
  action_summary: string;
  source_items: string[];
  baseline_version?: string;
  expected_commit?: string;
  result_version?: string;
  result_commit?: string;
  /** 由 Task 结果发布形成的不可变仓库快照；用于新建完整 CKG。 */
  task_snapshot?: {
    repo_url: string;
    branch: string;
    commit: string;
    canonical_project: string;
  };
  contribution?: AssetContribution;
  skill_extraction?: SkillExtractionReceipt;
  status: AssetDepositionStatus;
  error?: string;
}

export interface TaskAssetDeposition {
  schema_version: 1;
  execution?: {
    status: 'completed' | 'failed' | 'interrupted';
    summary: string;
    turns?: number;
  };
  project: {
    name: string;
    repo_url: string;
    branch: string;
  };
  artifact_bundle: {
    base_commit: string;
    result_commit?: string;
    harness: string;
    agent_id?: string;
    session_ids: string[];
    sessions?: TaskSessionTrace[];
    manifest_uri?: string;
    patch_uri?: string;
    test_result_uri?: string;
    captured_at: string;
  };
  changed_files: TaskChangedFile[];
  verification: TaskVerification[];
  merge_items: AssetMergeItem[];
  updated_at: string;
}

export type TaskKind = 'feature' | 'bug';
export type TaskUsableAssetType = 'llm_wiki' | 'code_graph' | 'skill' | 'chat_memory';

export interface TaskUsableAsset {
  asset_id: string;
  asset_type: TaskUsableAssetType;
  name: string;
  source_task_id: string;
}

export interface RelatedTaskEvidence {
  type: 'same_project' | 'exact_entity' | 'same_file' | 'bm25';
  value?: string;
}

export interface RelatedTaskCandidate {
  task_id: string;
  title: string;
  relation: 'affects_feature';
  confidence: 'high' | 'medium';
  score: number;
  evidence: RelatedTaskEvidence[];
  available_assets: TaskUsableAsset[];
}

/** Task-scoped asset availability. This does not mutate an Agent's fixed loadout. */
export interface TaskAssetUsage {
  schema_version: 1;
  task_kind?: TaskKind;
  project_key: string;
  search?: {
    status: 'idle' | 'completed';
    searched_at?: string;
    candidates: RelatedTaskCandidate[];
  };
  related_tasks: Array<{
    task_id: string;
    title: string;
    relation: 'affects_feature';
    status: 'confirmed';
    evidence: RelatedTaskEvidence[];
  }>;
  enabled_assets: TaskUsableAsset[];
  updated_at: string;
}

export interface Task {
  task_id: string;
  team_id: string;
  creator_user_id: string;
  participants: string[];
  title: string;
  description: string;
  source_type: TaskSourceType;
  source_url: string;
  linked_agents: string[];
  status: TaskStatus;
  created_at_ms: number;
  updated_at_ms: number;
  metadata_json?: string;
  asset_deposition?: TaskAssetDeposition;
  asset_usage?: TaskAssetUsage;
}

// ========================= metadata_json 兜底读写（"ui" namespace） =========================

interface AgentUiMeta {
  role_prompt: string;
  rules_prompt: string;
  icon: string;
  accent: Agent['accent'];
  skills: string[];
  code_graphs: string[];
  llm_wikis: string[];
  chat_memories: string[];
}

const ACCENT_CYCLE: Agent['accent'][] = ['blue', 'purple', 'orange', 'emerald', 'rose', 'slate'];
const ICON_CYCLE = ['🤖', '✨', '⚡', '🎯', '🚀', '🧩'];

function defaultAgentUiMeta(index: number): AgentUiMeta {
  return {
    role_prompt: '',
    rules_prompt: '',
    icon: ICON_CYCLE[index % ICON_CYCLE.length],
    accent: ACCENT_CYCLE[index % ACCENT_CYCLE.length],
    skills: [],
    code_graphs: [],
    llm_wikis: [],
    chat_memories: [],
  };
}

function readAgentUiMeta(metadataJson: string | undefined, index: number): AgentUiMeta {
  const fallback = defaultAgentUiMeta(index);
  if (!metadataJson) return fallback;
  try {
    const meta = JSON.parse(metadataJson) as Record<string, unknown>;
    const slot = meta?.ui;
    if (slot && typeof slot === 'object') {
      return { ...fallback, ...(slot as Partial<AgentUiMeta>) };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/** 把 ui 专属字段 merge 写回 metadata_json（保留其它 namespace，如 chat_memory）。 */
export function writeAgentUiMeta(prevMetadataJson: string | undefined, patch: Partial<AgentUiMeta>): string {
  let meta: Record<string, unknown> = {};
  if (prevMetadataJson) {
    try {
      const parsed = JSON.parse(prevMetadataJson);
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch {
      /* 旧值不合法直接丢 */
    }
  }
  const prevUi = (meta.ui && typeof meta.ui === 'object' ? meta.ui : {}) as Partial<AgentUiMeta>;
  meta.ui = { ...prevUi, ...patch };
  return JSON.stringify(meta);
}

interface TaskUiMeta {
  participants: string[];
}

function readTaskUiMeta(metadataJson: string | undefined, fallbackParticipant: string): TaskUiMeta {
  const fallback: TaskUiMeta = { participants: fallbackParticipant ? [fallbackParticipant] : [] };
  if (!metadataJson) return fallback;
  try {
    const meta = JSON.parse(metadataJson) as Record<string, unknown>;
    const slot = meta?.ui as Partial<TaskUiMeta> | undefined;
    if (slot && Array.isArray(slot.participants)) {
      return { participants: Array.from(new Set([...(slot.participants as string[]), fallbackParticipant].filter(Boolean))) };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function writeTaskUiMeta(prevMetadataJson: string | undefined, patch: Partial<TaskUiMeta>): string {
  let meta: Record<string, unknown> = {};
  if (prevMetadataJson) {
    try {
      const parsed = JSON.parse(prevMetadataJson);
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  const prevUi = (meta.ui && typeof meta.ui === 'object' ? meta.ui : {}) as Partial<TaskUiMeta>;
  meta.ui = { ...prevUi, ...patch };
  return JSON.stringify(meta);
}

/** 读取 Task 的资产沉淀命名空间；格式异常时不影响 Task 其它信息展示。 */
export function readTaskAssetDeposition(metadataJson: string | undefined): TaskAssetDeposition | undefined {
  if (!metadataJson) return undefined;
  try {
    const meta = JSON.parse(metadataJson) as Record<string, unknown>;
    const value = meta.asset_deposition as TaskAssetDeposition | undefined;
    if (!value || value.schema_version !== 1 || !value.project || !value.artifact_bundle) return undefined;
    const normalized = {
      ...value,
      changed_files: Array.isArray(value.changed_files) ? value.changed_files : [],
      verification: Array.isArray(value.verification) ? value.verification : [],
      merge_items: Array.isArray(value.merge_items) ? value.merge_items : [],
    };
    return hasTaskAssetEvidence(normalized) ? normalized : undefined;
  } catch {
    return undefined;
  }
}

/** 更新资产沉淀命名空间，同时保留 ui/chat_memory 等其它 Task 元数据。 */
export function writeTaskAssetDeposition(
  prevMetadataJson: string | undefined,
  deposition: TaskAssetDeposition,
): string {
  let meta: Record<string, unknown> = {};
  if (prevMetadataJson) {
    try {
      const parsed = JSON.parse(prevMetadataJson);
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch {
      /* 旧值不合法时只写入新的资产沉淀数据。 */
    }
  }
  meta.asset_deposition = deposition;
  return JSON.stringify(meta);
}

export function readTaskAssetUsage(metadataJson: string | undefined): TaskAssetUsage | undefined {
  if (!metadataJson) return undefined;
  try {
    const meta = JSON.parse(metadataJson) as Record<string, unknown>;
    const value = meta.asset_usage as TaskAssetUsage | undefined;
    if (!value || value.schema_version !== 1) return undefined;
    return {
      ...value,
      project_key: typeof value.project_key === 'string' ? value.project_key : '',
      related_tasks: Array.isArray(value.related_tasks) ? value.related_tasks : [],
      enabled_assets: Array.isArray(value.enabled_assets) ? value.enabled_assets : [],
      search: value.search && Array.isArray(value.search.candidates)
        ? value.search
        : { status: 'idle', candidates: [] },
    };
  } catch {
    return undefined;
  }
}

export function writeTaskAssetUsage(
  prevMetadataJson: string | undefined,
  usage: TaskAssetUsage,
): string {
  let meta: Record<string, unknown> = {};
  if (prevMetadataJson) {
    try {
      const parsed = JSON.parse(prevMetadataJson);
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch {
      /* Preserve the new namespace even when legacy metadata is malformed. */
    }
  }
  meta.asset_usage = usage;
  return JSON.stringify(meta);
}

// ========================= Adapters（export 供 stores/backend.ts 使用） =========================

export function adaptTeam(bt: BackendTeam, members: TeamMember[]): Team {
  return {
    team_id: bt.team_id,
    name: bt.name,
    description: bt.description ?? '',
    owner_user_id: bt.owner_user_id,
    created_at_ms: new Date(bt.created_at).getTime(),
    members,
  };
}

export function adaptMember(bm: BackendMember): TeamMember {
  return {
    user_id: bm.user_id,
    role: bm.role,
    joined_at_ms: new Date(bm.joined_at).getTime(),
    username: bm.username,
  };
}

export function adaptAgent(ba: BackendAgent, index: number): Agent {
  const ui = readAgentUiMeta(ba.metadata_json, index);
  // prompt 回退：当 metadata_json 不含 ui.role_prompt 时（agent 可能通过后端 API 直接创建，
  // 而非前端 UI），从后端 prompt 字段回退。prompt 是 role+rules 合在一起的完整文本，
  // 没有 ui 拆分时整体放到 role_prompt，rules_prompt 保持空。
  const rolePrompt = ui.role_prompt || ba.prompt || '';
  return {
    agent_id: ba.agent_id,
    team_id: ba.team_id,
    owner_user_id: ba.owner_user_id,
    name: ba.name,
    description: ba.description ?? '',
    role_prompt: rolePrompt,
    rules_prompt: ui.rules_prompt,
    icon: ui.icon,
    accent: ui.accent,
    // 资产绑定不再从 metadata_json.ui 读（.ui 已废弃为资产存储）。
    // 真实绑定读 skill 表 owner_agent_id / agent-fixed-asset 表：
    // list 计数走 agent-overview/bootstrap.counts，详情弹窗走 skillApi.listByAgent
    // + knowledgeApi.agentFixed + chatMemoryApi.agentFixed。这些字段保留仅为类型兼容。
    skills: [],
    code_graphs: [],
    llm_wikis: [],
    chat_memories: [],
    metadata_json: ba.metadata_json,
    created_at_ms: new Date(ba.created_at).getTime(),
    updated_at_ms: new Date(ba.updated_at).getTime(),
  };
}

function normalizeTaskStatus(backend: BackendTask['status']): TaskStatus {
  return backend === 'completed' ? 'completed' : 'running';
}

export function adaptTask(bt: BackendTask, linkedAgents: string[]): Task {
  const ui = readTaskUiMeta(bt.metadata_json, bt.creator_user_id);
  return {
    task_id: bt.task_id,
    team_id: bt.team_id,
    creator_user_id: bt.creator_user_id,
    participants: ui.participants,
    title: bt.title,
    description: bt.description ?? '',
    source_type: bt.source_type,
    source_url: bt.source_url ?? '',
    linked_agents: linkedAgents,
    status: normalizeTaskStatus(bt.status),
    created_at_ms: new Date(bt.created_at).getTime(),
    updated_at_ms: new Date(bt.updated_at).getTime(),
    metadata_json: bt.metadata_json,
    asset_deposition: readTaskAssetDeposition(bt.metadata_json),
    asset_usage: readTaskAssetUsage(bt.metadata_json),
  };
}

// ========================= Active team id（客户端 UI 状态，localStorage 持久化） =========================

const ACTIVE_TEAM_KEY = 'tdai-memory.activeTeam.v1';
const LOCAL_CHANGE_EVENT = 'tdai-memory.demo-store-change';

export function readActiveTeamId(): string | null {
  try { return localStorage.getItem(ACTIVE_TEAM_KEY); } catch { return null; }
}

export function writeActiveTeamId(teamId: string | null): void {
  try {
    if (teamId) localStorage.setItem(ACTIVE_TEAM_KEY, teamId);
    else localStorage.removeItem(ACTIVE_TEAM_KEY);
  } catch { /* ignore */ }
  try { window.dispatchEvent(new Event(LOCAL_CHANGE_EVENT)); } catch { /* ignore */ }
}

/** teams 加载完成后确保 activeTeamId 指向一个有效 team（否则选第一个 / 清空）。 */
export function ensureValidActiveTeamId(teams: Team[]): void {
  const cur = readActiveTeamId();
  if (cur && teams.some((t) => t.team_id === cur)) return;
  if (teams.length === 0) {
    if (cur) writeActiveTeamId(null);
    return;
  }
  writeActiveTeamId(teams[0].team_id);
}

// ========================= Hooks & cache（已迁移到 stores/backend.ts） =========================
//
// 旧的模块级变量（_cachedTeams / _cachedAgentsMap / _inflightTeams …）已全部
// 迁移到 zustand store（stores/backend.ts），通过 useTeams / useAgents / useTasks
// 从 store 读数据 + 触发 fetch，多个组件共享同一份状态，不再重复请求。
//
// invalidateBackendCache / clearBackendCache 也由新 store 提供，这里 re-export
// 保持调用方无需改 import 路径。

export {
  useTeams,
  useAgents,
  useTasks,
  readActiveTeamAgents,
  invalidateBackendCache,
  clearBackendCache,
  invalidateTeamCache,
} from '@/stores/backend';

// ========================= Permissions =========================

export function roleInTeam(team: Team | null | undefined, userId: string): 'admin' | 'member' | 'reviewer' | null {
  if (!team) return null;
  const member = team.members.find((m) => m.user_id === userId);
  if (member) return member.role;
  // team owner 如果不在 members 列表里（后端 owner 不一定出现在 members 数组中），
  // 默认按 'member' 处理——owner 在 team 内能管理资源，应能看到资源页。
  // 不返回 'admin' 是因为 useCurrentRole 返回的 'admin' 语义是"全局 admin"（看不到资源页），
  // team owner 不是全局 admin，不应被 AdminResourceLock 锁住。
  if (team.owner_user_id === userId) return 'member';
  return null;
}

export function isTeamAdmin(team: Team | null | undefined, userId: string): boolean {
  if (!team) return false;
  if (team.owner_user_id === userId) return true;
  return team.members.some((m) => m.user_id === userId && m.role === 'admin');
}

export function isTeamMember(team: Team | null | undefined, userId: string): boolean {
  return roleInTeam(team, userId) !== null;
}

export function canManageAsset(
  asset: { owner_user_id: string; team_id: string },
  team: Team | null | undefined,
  userId: string,
  _isGlobalAdminFlag?: boolean
): boolean {
  if (!userId) return false;
  // admin 不再拥有全局特权，与 member 一致：只能操作自己 owner 的资产。
  if (asset.owner_user_id === userId) return true;
  if (team && team.team_id === asset.team_id && isTeamAdmin(team, userId)) return true;
  return false;
}

export function canEditTask(task: Task, team: Team | null | undefined, userId: string): boolean {
  if (!userId) return false;
  if (!team || team.team_id !== task.team_id) return false;
  return isTeamMember(team, userId);
}

export function canDeleteTask(task: Task, team: Team | null | undefined, userId: string): boolean {
  return canManageAsset({ owner_user_id: task.creator_user_id, team_id: task.team_id }, team, userId);
}

// ========================= Task mutations（async，包一层 diff/参与者逻辑） =========================

export async function createTaskAsync(input: {
  team_id: string;
  creator_user_id: string;
  title: string;
  description: string;
  source_type: TaskSourceType;
  source_url: string;
  linked_agents: string[];
}): Promise<Task> {
  const created = await tasksApi.create(input.team_id, {
    title: input.title,
    description: input.description,
    source_type: input.source_type,
    source_url: input.source_url || undefined,
    linked_agents: input.linked_agents.length > 0 ? input.linked_agents : undefined,
  });
  invalidateBackendCache();
  return adaptTask(created, input.linked_agents);
}

export async function deleteTaskAsync(taskId: string): Promise<void> {
  await tasksApi.delete(taskId);
  invalidateBackendCache();
}

export async function updateTaskStatusAsync(taskId: string, status: TaskStatus, actorUserId?: string): Promise<void> {
  const patch: Record<string, unknown> = { status };
  if (actorUserId) {
    // 参与者留痕：读一次当前 task 详情，把 actor 并入 participants 再写回 metadata_json
    try {
      const current = await tasksApi.get(taskId);
      const ui = readTaskUiMeta(current.metadata_json, current.creator_user_id);
      if (!ui.participants.includes(actorUserId)) {
        patch.metadata_json = writeTaskUiMeta(current.metadata_json, {
          participants: [...ui.participants, actorUserId],
        });
      }
    } catch { /* 参与者留痕失败不阻断状态切换 */ }
  }
  await tasksApi.update(taskId, patch as Parameters<typeof tasksApi.update>[1]);
  invalidateBackendCache();
}

export async function updateTaskAsync(
  taskId: string,
  patch: Partial<Pick<Task, 'title' | 'description' | 'source_type' | 'source_url' | 'linked_agents'>>,
  actorUserId?: string
): Promise<void> {
  const current = await tasksApi.get(taskId);
  const updatePayload: Record<string, unknown> = {};
  if (patch.title !== undefined) updatePayload.title = patch.title;
  if (patch.description !== undefined) updatePayload.description = patch.description;
  if (patch.source_url !== undefined) updatePayload.source_url = patch.source_url;

  const ui = readTaskUiMeta(current.metadata_json, current.creator_user_id);
  const nextParticipants = actorUserId && !ui.participants.includes(actorUserId)
    ? [...ui.participants, actorUserId]
    : ui.participants;
  if (nextParticipants !== ui.participants) {
    updatePayload.metadata_json = writeTaskUiMeta(current.metadata_json, { participants: nextParticipants });
  }
  if (Object.keys(updatePayload).length > 0) {
    await tasksApi.update(taskId, updatePayload as Parameters<typeof tasksApi.update>[1]);
  }

  if (patch.linked_agents) {
    const before = new Set(current.agents.filter((a) => a.status === 'active').map((a) => a.agent_id));
    const after = new Set(patch.linked_agents);
    const toLink = [...after].filter((id) => !before.has(id));
    const toUnlink = [...before].filter((id) => !after.has(id));
    await Promise.all([
      ...toLink.map((id) => tasksApi.linkAgent(taskId, id)),
      ...toUnlink.map((id) => tasksApi.unlinkAgent(taskId, id)),
    ]);
  }
  invalidateBackendCache();
}

/** 保存 Task 资产包及合并计划；会话和测试日志走 URI，待沉淀的小型文档全文随 Task 保存。 */
export async function updateTaskAssetDepositionAsync(
  taskId: string,
  deposition: TaskAssetDeposition,
): Promise<void> {
  const current = await tasksApi.get(taskId);
  const nextDeposition = {
    ...deposition,
    updated_at: new Date().toISOString(),
  };
  const metadataJson = writeTaskAssetDeposition(current.metadata_json, nextDeposition);
  const updated = await tasksApi.update(taskId, { metadata_json: metadataJson });

  // 该操作只更新 metadata，直接替换当前页中的 Task，避免全局 invalidate 使详情
  // 抽屉在重新拉取期间卸载。其它浏览器仍会在下次正常刷新时拿到后端最新值。
  updateCachedTask(taskId, (task) => ({
    ...task,
    metadata_json: updated.metadata_json,
    asset_deposition: nextDeposition,
    updated_at_ms: new Date(updated.updated_at).getTime(),
  }));
}

function projectKeyFromUrl(value: string | undefined): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.hostname.toLowerCase() === 'github.com' && parts.length >= 2) {
      return `${parts[0]}/${parts[1].replace(/\.git$/i, '')}`.toLowerCase();
    }
    return `${url.hostname}${url.pathname.replace(/\.git$/i, '').replace(/\/$/, '')}`.toLowerCase();
  } catch {
    return value.trim().replace(/\.git$/i, '').replace(/\/$/, '').toLowerCase();
  }
}

export function deriveTaskProjectKey(task: Pick<Task, 'source_url' | 'asset_deposition' | 'asset_usage'>): string {
  return task.asset_usage?.project_key
    || projectKeyFromUrl(task.asset_deposition?.project.repo_url)
    || projectKeyFromUrl(task.source_url);
}

function extractIdentifiers(text: string): Set<string> {
  const result = new Set<string>();
  const add = (raw: string) => {
    const value = raw.trim().replace(/[()]+$/g, '').split('.').pop()?.toLowerCase();
    if (value && value.length >= 3) result.add(value);
  };
  for (const match of text.matchAll(/`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)`/g)) add(match[1]);
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\b/g)) add(match[1]);
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*_[A-Za-z0-9_$]+)\b/g)) add(match[1]);
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) add(match[1]);
  return result;
}

function extractPaths(text: string): Set<string> {
  const paths = new Set<string>();
  for (const match of text.matchAll(/(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g)) {
    paths.add(match[0].replace(/\\/g, '/').toLowerCase());
  }
  return paths;
}

const SEARCH_STOP_WORDS = new Set([
  'this', 'that', 'with', 'from', 'into', 'when', 'then', 'task', 'issue', 'feature', 'bug',
  'implement', 'implementation', 'fix', '修复', '实现', '功能', '问题', '任务', '项目',
]);

/**
 * Tokenize task text for BM25. ASCII/code terms stay intact; contiguous Chinese
 * text is expanded into character bigrams so two differently worded sentences
 * can still share useful terms without requiring an external segmenter.
 */
function tokenizeSearchText(text: string): string[] {
  const terms: string[] = [];
  const chunks = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  for (const chunk of chunks) {
    if (/^[\p{Script=Han}]+$/u.test(chunk)) {
      if (chunk.length === 1) continue;
      if (chunk.length === 2 && !SEARCH_STOP_WORDS.has(chunk)) terms.push(chunk);
      for (let index = 0; index < chunk.length - 1; index += 1) {
        const bigram = chunk.slice(index, index + 2);
        if (!SEARCH_STOP_WORDS.has(bigram)) terms.push(bigram);
      }
      continue;
    }
    if (chunk.length >= 3 && !SEARCH_STOP_WORDS.has(chunk)) terms.push(chunk);
  }
  return terms;
}

function countTerms(terms: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}

function scoreBm25(
  queryTerms: string[],
  documentTerms: string[],
  documentFrequency: Map<string, number>,
  documentCount: number,
  averageDocumentLength: number,
): { score: number; matchedTerms: string[] } {
  if (documentCount === 0 || documentTerms.length === 0 || averageDocumentLength === 0) {
    return { score: 0, matchedTerms: [] };
  }
  const k1 = 1.5;
  const b = 0.75;
  const frequencies = countTerms(documentTerms);
  const uniqueQueryTerms = [...new Set(queryTerms)];
  const matches: Array<{ term: string; contribution: number }> = [];
  let score = 0;

  for (const term of uniqueQueryTerms) {
    const frequency = frequencies.get(term) ?? 0;
    if (frequency === 0) continue;
    const df = documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
    const lengthNormalization = k1 * (
      1 - b + b * documentTerms.length / averageDocumentLength
    );
    const contribution = idf * (frequency * (k1 + 1)) / (frequency + lengthNormalization);
    score += contribution;
    matches.push({ term, contribution });
  }

  matches.sort((left, right) => right.contribution - left.contribution);
  return { score, matchedTerms: matches.slice(0, 5).map((match) => match.term) };
}

function publishedTaskAssets(task: Task): TaskUsableAsset[] {
  const result: TaskUsableAsset[] = [];
  for (const item of task.asset_deposition?.merge_items ?? []) {
    if (item.status !== 'merged') continue;
    if (item.asset_type === 'llm_wiki' || item.asset_type === 'code_graph') {
      if (item.target_asset_id) {
        result.push({
          asset_id: item.target_asset_id,
          asset_type: item.asset_type,
          name: item.target_name,
          source_task_id: task.task_id,
        });
      }
    } else if (item.asset_type === 'skill') {
      const ids = item.contribution?.skill_ids
        ?? (item.target_asset_id ? [item.target_asset_id] : []);
      const legacyNames = item.target_name.split('、').map((name) => name.trim()).filter(Boolean);
      for (const [index, id] of ids.entries()) {
        result.push({
          asset_id: id,
          asset_type: 'skill',
          name: item.contribution?.skill_names?.[id] ?? legacyNames[index] ?? item.target_name,
          source_task_id: task.task_id,
        });
      }
    }
  }
  return [...new Map(result.map((asset) => [`${asset.asset_type}:${asset.asset_id}`, asset])).values()];
}

function featureSearchCorpus(task: Task): string {
  const deposition = task.asset_deposition;
  const parts = [task.title, task.description];
  for (const file of deposition?.changed_files ?? []) parts.push(file.path);
  for (const item of deposition?.merge_items ?? []) {
    parts.push(item.target_name, item.action_summary, ...item.source_items);
    for (const entity of item.contribution?.code_entities ?? []) {
      parts.push(entity.name, entity.path ?? '');
    }
    parts.push(...(item.contribution?.wiki_page_refs ?? []));
  }
  return parts.filter(Boolean).join(' ');
}

/**
 * Related-feature lookup using BM25 text relevance with auditable code-identifier
 * and changed-file boosts.
 */
export async function findRelatedFeatureTasksAsync(task: Task, projectKey: string): Promise<RelatedTaskCandidate[]> {
  const normalizedProject = projectKey.trim().toLowerCase();
  if (!normalizedProject) return [];

  const backendTasks = await tasksApi.list(task.team_id);
  const bugText = `${task.title} ${task.description}`;
  const bugIdentifiers = extractIdentifiers(bugText);
  const bugPaths = extractPaths(bugText);
  const bugTerms = tokenizeSearchText(bugText);
  const candidates: RelatedTaskCandidate[] = [];
  const searchableFeatures: Array<{
    feature: Task;
    assets: TaskUsableAsset[];
    identifiers: Set<string>;
    paths: Set<string>;
    terms: string[];
  }> = [];

  for (const backendTask of backendTasks) {
    if (backendTask.task_id === task.task_id) continue;
    const feature = adaptTask(backendTask, []);
    if (feature.status !== 'completed' || feature.created_at_ms >= task.created_at_ms) continue;
    if (feature.asset_usage?.task_kind !== 'feature') continue;
    if (deriveTaskProjectKey(feature) !== normalizedProject) continue;

    const assets = publishedTaskAssets(feature);
    if (assets.length === 0) continue;

    const corpus = featureSearchCorpus(feature);
    const featureIdentifiers = extractIdentifiers(corpus);
    const featurePaths = new Set([
      ...extractPaths(corpus),
      ...(feature.asset_deposition?.changed_files ?? []).map((file) => file.path.toLowerCase()),
    ]);
    searchableFeatures.push({
      feature,
      assets,
      identifiers: featureIdentifiers,
      paths: featurePaths,
      terms: tokenizeSearchText(corpus),
    });
  }

  const documentFrequency = new Map<string, number>();
  for (const { terms } of searchableFeatures) {
    for (const term of new Set(terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const averageDocumentLength = searchableFeatures.length === 0
    ? 0
    : searchableFeatures.reduce((sum, item) => sum + item.terms.length, 0) / searchableFeatures.length;

  for (const { feature, assets, identifiers: featureIdentifiers, paths: featurePaths, terms } of searchableFeatures) {
    const bm25 = scoreBm25(
      bugTerms,
      terms,
      documentFrequency,
      searchableFeatures.length,
      averageDocumentLength,
    );

    const entityHits = [...bugIdentifiers].filter((id) => featureIdentifiers.has(id));
    const fileHits = [...bugPaths].filter((path) => {
      const basename = path.split('/').pop();
      return [...featurePaths].some((candidate) => candidate === path || candidate.endsWith(`/${basename}`));
    });

    let score = 0;
    const evidence: RelatedTaskEvidence[] = [{ type: 'same_project', value: normalizedProject }];
    if (entityHits.length > 0) {
      score += 100 + Math.min(entityHits.length - 1, 3) * 10;
      evidence.push({ type: 'exact_entity', value: entityHits.slice(0, 3).join(', ') });
    }
    if (fileHits.length > 0) {
      score += 60;
      evidence.push({ type: 'same_file', value: fileHits.slice(0, 2).join(', ') });
    }
    if (bm25.score > 0) {
      score += Math.min(bm25.score * 10, 50);
      evidence.push({
        type: 'bm25',
        value: `${bm25.score.toFixed(2)}${bm25.matchedTerms.length > 0 ? ` (${bm25.matchedTerms.join(', ')})` : ''}`,
      });
    }
    if (score === 0) continue;

    candidates.push({
      task_id: feature.task_id,
      title: feature.title,
      relation: 'affects_feature',
      confidence: entityHits.length > 0 || fileHits.length > 0 ? 'high' : 'medium',
      score,
      evidence,
      available_assets: assets,
    });
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, 5);
}

export async function updateTaskAssetUsageAsync(taskId: string, usage: TaskAssetUsage): Promise<void> {
  const current = await tasksApi.get(taskId);
  const nextUsage: TaskAssetUsage = { ...usage, updated_at: new Date().toISOString() };
  const metadataJson = writeTaskAssetUsage(current.metadata_json, nextUsage);
  const updated = await tasksApi.update(taskId, { metadata_json: metadataJson });
  updateCachedTask(taskId, (task) => ({
    ...task,
    metadata_json: updated.metadata_json,
    asset_usage: nextUsage,
    updated_at_ms: new Date(updated.updated_at).getTime(),
  }));
}
