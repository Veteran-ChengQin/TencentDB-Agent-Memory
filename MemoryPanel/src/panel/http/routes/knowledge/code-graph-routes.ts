/**
 * /api/v1/knowledge/code-graph/* —— Panel Code-Graph 业务路由（stateless）。
 *
 * 实现冻结契约 docs/api/knowledge-panel-api.md §2.0 Code 最小端点集，透传
 * HttpKnowledgeClient → KS /v3/code-graph/*。查询端点（search/explore）统一
 * 返回 KS 的 { text, isError } 文本块。
 */
import type { Hono } from 'hono';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError } from '../../envelope.js';
import type { PanelDeps } from '../../../panel-deps.js';
import { publishTaskSnapshot } from '../../../services/task-snapshot-publisher.js';
import { respondEnvelope } from '../../envelope.js';
import {
  buildCtx,
  readJson,
  str,
  strArray,
  okEnvelope,
  requireTeamMember,
  requireKnowledgeRead,
  runKs,
  ensureKnowledgeAsset,
  deleteKnowledgeCascade,
  ASSET_TYPE_CODE_GRAPH,
} from './common.js';

export function registerKnowledgeCodeGraphRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  // C2 list — @deprecated 面板 UI 已改用 team-assets / my-assets
  api.post('/knowledge/code-graph/list', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    const opts = {
      status: str(body, 'status') ?? undefined,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
      offset: typeof body.offset === 'number' ? body.offset : undefined,
    };
    return runKs(c, () => kc.codeGraphList(teamId, opts));
  });

  // C1 create — team 门控；KS create 后自动 build，meta 在 ready callback 登记
  api.post('/knowledge/code-graph/create', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const repoUrl = str(body, 'repo_url');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!repoUrl) return respondControlError(c, 400, 'MISSING_REPO_URL');
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const branch = str(body, 'branch') ?? undefined;
    const repoName = str(body, 'repo_name') ?? undefined;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    try {
      const detail = await kc.codeGraphCreate(teamId, repoUrl, branch, gate.userId, repoName);
      // stash owner key 供 status-callback ready 时以 owner 身份注册 meta asset
      // （callback 是 S2S、无 user_key；详见 knowledge-task-registry.ts）
      if (ctx.userKey) {
        deps.knowledgeTaskRegistry.record({
          knowledge_id: detail.code_graph_id,
          type: 'code-graph',
          team_id: teamId,
          owner_user_id: gate.userId,
          owner_user_key: ctx.userKey,
          service_id: ctx.instanceId,
          created_at: Date.now(),
        });
        deps.logger.info('[code-graph/create] stashed owner key for S2S meta register', {
          knowledge_id: detail.code_graph_id, team_id: teamId, owner: gate.userId,
        });
      } else {
        deps.logger.warn('[code-graph/create] no user_key in ctx; cannot stash for S2S register', {
          knowledge_id: detail.code_graph_id, team_id: teamId,
        });
      }
      return respondEnvelope(c, okEnvelope(c, detail));
    } catch (err) {
      return runKs(c, () => Promise.reject(err));
    }
  });

  // C3b register-meta — code ready 后 owner 登记 meta（create 时不写 meta）
  api.post('/knowledge/code-graph/register-meta', mw, async (c) => {
    const ctx = buildCtx(c);
    const log = deps.logger;
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const cgId = str(body, 'code_graph_id');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!cgId) return respondControlError(c, 400, 'MISSING_CODE_GRAPH_ID');
    log.info('[code-graph/register-meta] invoked (frontend fallback)', { code_graph_id: cgId, team_id: teamId });
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const readGate = await requireKnowledgeRead(deps, c, ctx, cgId, { allowInFlightCodeOwner: true });
    if ('error' in readGate) return readGate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    let detail;
    try {
      detail = await kc.codeGraphGet(cgId);
    } catch (err) {
      return runKs(c, () => Promise.reject(err));
    }
    if (detail.status !== 'ready') {
      log.warn('[code-graph/register-meta] not ready → 409', { code_graph_id: cgId, status: detail.status });
      return respondControlError(c, 409, 'CODE_GRAPH_NOT_READY');
    }
    if (detail.owner_user_id && detail.owner_user_id !== gate.userId) {
      log.warn('[code-graph/register-meta] owner mismatch → 403', {
        code_graph_id: cgId, ks_owner: detail.owner_user_id, caller: gate.userId,
      });
      return respondControlError(c, 403, 'NOT_RESOURCE_OWNER');
    }
    log.info('[code-graph/register-meta] gating passed; registering meta asset', {
      code_graph_id: cgId, owner: gate.userId,
    });
    const reg = await ensureKnowledgeAsset(deps, ctx, {
      assetId: detail.code_graph_id,
      teamId: detail.team_id,
      assetType: ASSET_TYPE_CODE_GRAPH,
      name: detail.repo_name || detail.repo_url,
      ownerUserId: gate.userId,
      serviceUrl: detail.service_url,
    });
    if (!reg.ok) return respondEnvelope(c, reg.env);
    return respondEnvelope(c, okEnvelope(c, { registered: true, code_graph_id: cgId }));
  });

  // C3 get — id-only（构建中无 meta 时 owner 可读）
  api.post('/knowledge/code-graph/get', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const cgId = str(body, 'code_graph_id');
    if (!cgId) return respondControlError(c, 400, 'MISSING_CODE_GRAPH_ID');
    const gate = await requireKnowledgeRead(deps, c, ctx, cgId, { allowInFlightCodeOwner: true });
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.codeGraphGet(cgId));
  });

  // C4 sync — id-only
  api.post('/knowledge/code-graph/sync', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const cgId = str(body, 'code_graph_id');
    if (!cgId) return respondControlError(c, 400, 'MISSING_CODE_GRAPH_ID');
    const gate = await requireKnowledgeRead(deps, c, ctx, cgId, { action: 'write', allowInFlightCodeOwner: true });
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.codeGraphSync(cgId));
  });

  // Task 结果快照：把 base commit + Agent patch 发布到受控 GitHub 分支，
  // 然后复用既有 codeGraphCreate 链路建立一个完整、可直接查询的 CKG。
  api.post('/knowledge/code-graph/task-snapshot/create', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const taskId = str(body, 'task_id');
    const sourceRepoUrl = str(body, 'source_repo_url');
    const canonicalProject = str(body, 'canonical_project');
    const baseCommit = str(body, 'base_commit');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!taskId) return respondControlError(c, 400, 'MISSING_TASK_ID');
    if (!sourceRepoUrl) return respondControlError(c, 400, 'MISSING_REPO_URL');
    if (!canonicalProject) return respondControlError(c, 400, 'MISSING_CANONICAL_PROJECT');
    if (!baseCommit) return respondControlError(c, 400, 'MISSING_BASE_COMMIT');
    if (typeof body.patch !== 'string') return respondControlError(c, 400, 'MISSING_PATCH');

    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in gate) return gate.error;
    const taskEnv = await deps.metaKernel.invoke('task/get', { task_id: taskId }, ctx);
    const task = taskEnv.data as { team_id?: string; title?: string } | null;
    if (taskEnv.code !== 0 || !task) return respondControlError(c, 404, 'TASK_NOT_FOUND');
    if (task.team_id !== teamId) return respondControlError(c, 403, 'TASK_TEAM_MISMATCH');

    try {
      const snapshot = await publishTaskSnapshot({
        taskId,
        sourceRepoUrl,
        canonicalProject,
        baseCommit,
        patch: body.patch,
        taskTitle: task.title,
      });
      const kc = deps.knowledgeClientFactory(ctx.instanceId);
      const detail = await kc.codeGraphCreate(
        teamId,
        snapshot.repoUrl,
        snapshot.branch,
        gate.userId,
        `Task 快照 · ${canonicalProject} · ${taskId}`,
      );
      if (ctx.userKey) {
        deps.knowledgeTaskRegistry.record({
          knowledge_id: detail.code_graph_id,
          type: 'code-graph',
          team_id: teamId,
          owner_user_id: gate.userId,
          owner_user_key: ctx.userKey,
          service_id: ctx.instanceId,
          created_at: Date.now(),
        });
      }
      return respondEnvelope(c, okEnvelope(c, { code_graph: detail, snapshot }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error('[task-snapshot] publish failed', { task_id: taskId, message });
      return respondControlError(c, 502, message);
    }
  });

  // Task delta: records a task contribution without mutating the shared project graph.
  api.post('/knowledge/code-graph/task-diff/build', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, 'team_id');
    const taskId = str(body, 'task_id');
    const cgId = str(body, 'code_graph_id');
    const baseCommit = str(body, 'base_commit');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');
    if (!taskId) return respondControlError(c, 400, 'MISSING_TASK_ID');
    if (!cgId) return respondControlError(c, 400, 'MISSING_CODE_GRAPH_ID');
    if (!baseCommit) return respondControlError(c, 400, 'MISSING_BASE_COMMIT');
    if (typeof body.patch !== 'string') return respondControlError(c, 400, 'MISSING_PATCH');
    const memberGate = await requireTeamMember(deps, c, ctx, teamId);
    if ('error' in memberGate) return memberGate.error;
    const readGate = await requireKnowledgeRead(deps, c, ctx, cgId);
    if ('error' in readGate) return readGate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.taskCodeGraphChangeBuild({
      team_id: teamId,
      task_id: taskId,
      code_graph_id: cgId,
      base_commit: baseCommit,
      result_commit: str(body, 'result_commit') ?? undefined,
      result_snapshot: str(body, 'result_snapshot') ?? undefined,
      patch: body.patch as string,
      before_files: body.before_files && typeof body.before_files === 'object'
        ? body.before_files as Record<string, string>
        : undefined,
      after_files: body.after_files && typeof body.after_files === 'object'
        ? body.after_files as Record<string, string>
        : undefined,
    }));
  });

  api.post('/knowledge/code-graph/task-diff/get', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const taskId = str(body, 'task_id');
    const cgId = str(body, 'code_graph_id');
    if (!taskId) return respondControlError(c, 400, 'MISSING_TASK_ID');
    if (!cgId) return respondControlError(c, 400, 'MISSING_CODE_GRAPH_ID');
    const gate = await requireKnowledgeRead(deps, c, ctx, cgId);
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.taskCodeGraphChangeGet(taskId, cgId));
  });

  api.post('/knowledge/code-graph/task-diff/status', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const taskId = str(body, 'task_id');
    const cgId = str(body, 'code_graph_id');
    const status = str(body, 'status');
    if (!taskId) return respondControlError(c, 400, 'MISSING_TASK_ID');
    if (!cgId) return respondControlError(c, 400, 'MISSING_CODE_GRAPH_ID');
    if (status !== 'candidate' && status !== 'merged' && status !== 'obsolete') {
      return respondControlError(c, 400, 'INVALID_TASK_CODE_GRAPH_STATUS');
    }
    const gate = await requireKnowledgeRead(deps, c, ctx, cgId, { action: 'write' });
    if ('error' in gate) return gate.error;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.taskCodeGraphChangeStatus(taskId, cgId, status));
  });

  // C5 delete — 删三处：KS + entity_knowledge 明细 + meta_asset（见 §0.6）
  api.post('/knowledge/code-graph/delete', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const cgIds = strArray(body, 'code_graph_ids');
    if (cgIds.length === 0) return respondControlError(c, 400, 'MISSING_CODE_GRAPH_ID');
    for (const cgId of cgIds) {
      const gate = await requireKnowledgeRead(deps, c, ctx, cgId, {
        action: 'write',
        allowInFlightCodeOwner: true,
      });
      if ('error' in gate) return gate.error;
    }
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, async () => {
      const result = await kc.codeGraphDelete(cgIds);
      await deleteKnowledgeCascade(deps, ctx, cgIds);
      return result;
    });
  });

  // C7 search — id-only
  api.post('/knowledge/code-graph/search', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const cgId = str(body, 'code_graph_id');
    const query = str(body, 'query');
    if (!cgId) return respondControlError(c, 400, 'MISSING_CODE_GRAPH_ID');
    if (!query) return respondControlError(c, 400, 'MISSING_QUERY');
    const gate = await requireKnowledgeRead(deps, c, ctx, cgId);
    if ('error' in gate) return gate.error;
    const params: Record<string, unknown> = { query };
    if (str(body, 'kind')) params.kind = str(body, 'kind');
    if (typeof body.limit === 'number') params.limit = body.limit;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.codeGraphQuery(cgId, 'search', params));
  });

  // C8 explore — id-only
  api.post('/knowledge/code-graph/explore', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const cgId = str(body, 'code_graph_id');
    const query = str(body, 'query');
    if (!cgId) return respondControlError(c, 400, 'MISSING_CODE_GRAPH_ID');
    if (!query) return respondControlError(c, 400, 'MISSING_QUERY');
    const gate = await requireKnowledgeRead(deps, c, ctx, cgId);
    if ('error' in gate) return gate.error;
    const params: Record<string, unknown> = { query };
    if (typeof body.maxFiles === 'number') params.maxFiles = body.maxFiles;
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    return runKs(c, () => kc.codeGraphQuery(cgId, 'explore', params));
  });
}
