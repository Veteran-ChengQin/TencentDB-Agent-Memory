import { useEffect, useMemo, useState } from 'react';
import { Button, Text } from 'tea-component';
import {
  BookOpen,
  Bot,
  CircleCheck,
  CircleX,
  FileCode2,
  FileQuestion,
  FileText,
  Files,
  FlaskConical,
  Network,
  Package,
  Settings2,
  Wrench,
} from 'lucide-react';
import {
  knowledgeApi,
  type CodeGraphDetail,
  type GraphData,
  type TaskCodeGraphChange,
  type WikiDetail,
  type WikiPage,
} from '@/lib/knowledge-api';
import {
  extractSkills,
  getSkill,
  listSkills,
  type SkillDetail,
  type SkillSummary,
} from '@/lib/skill-api';
import { tea } from '@/lib/tea-bridge';
import type {
  AssetMergeItem,
  TaskAssetDeposition,
  TaskChangedFile,
  TaskSessionMessage,
} from '@/services';
import KnowledgeGraph from '@/pages/wiki/WikiPage/components/KnowledgeGraph';
import { assembleTaskPatch } from './task-patch';

const CATEGORY_LABEL: Record<TaskChangedFile['category'], string> = {
  code: '代码',
  document: '文档',
  test: '测试',
  config: '配置',
  other: '其他',
};

const OPERATION_LABEL: Record<TaskChangedFile['operation'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名',
};

const STATUS_LABEL: Record<AssetMergeItem['status'], string> = {
  saved: '已保存',
  pending_review: '待审核',
  approved: '已批准',
  publishing: '生成中',
  merged: '已沉淀',
  blocked: '验证阻断',
  conflict: '存在冲突',
  failed: '生成失败',
  skipped: '未生成',
};

const NEW_TASK_SNAPSHOT_CKG = '__new_task_snapshot_ckg__';
type CodeEntityKind = NonNullable<NonNullable<AssetMergeItem['contribution']>['code_entities']>[number]['kind'];

function canonicalProjectFromUrl(repoUrl: string): string | undefined {
  try {
    const url = new URL(repoUrl);
    if (url.hostname.toLowerCase() !== 'github.com') return undefined;
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
    return parts.length === 2 && parts.every(Boolean) ? `${parts[0]}/${parts[1]}` : undefined;
  } catch {
    return undefined;
  }
}

const TYPE_LABEL: Record<AssetMergeItem['asset_type'], string> = {
  task_bundle: '任务证据包',
  llm_wiki: '项目 Wiki',
  code_graph: '项目代码图谱',
  skill: '团队 Skill',
};

const TYPE_ICON = {
  task_bundle: Package,
  llm_wiki: BookOpen,
  code_graph: Network,
  skill: Wrench,
} as const;

const CATEGORY_ICON = {
  code: FileCode2,
  document: FileText,
  test: FlaskConical,
  config: Settings2,
  other: FileQuestion,
} as const;

interface AssetPreview {
  loading: boolean;
  wikiPages?: WikiPage[];
  wikiGraph?: GraphData;
  wikiRawFiles?: Array<{ filename: string; size: number }>;
  wikiSamples?: Array<{ path: string; title: string; content: string }>;
  codeGraph?: CodeGraphDetail;
  codeGraphText?: string;
  taskCodeGraphChange?: TaskCodeGraphChange;
  skills?: SkillDetail[];
  error?: string;
}

const SESSION_ROLE_LABEL: Record<TaskSessionMessage['role'], string> = {
  user: '任务输入',
  assistant: 'Agent 回复',
  tool_call: '工具调用',
  tool_result: '工具结果',
  system: '系统信息',
};

interface WikiPageSnapshot {
  pages: WikiPage[];
  contentByRef: Map<string, string>;
}

function countFiles(files: TaskChangedFile[], category: TaskChangedFile['category']): number {
  return files.filter((file) => file.category === category).length;
}

function diffLineKind(line: string): string {
  if (line.startsWith('@@')) return 'is-hunk';
  if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) return 'is-meta';
  if (line.startsWith('+')) return 'is-add';
  if (line.startsWith('-')) return 'is-delete';
  return 'is-context';
}

function parseDiffLines(diff: string): Array<{ text: string; kind: string; oldLine?: number; newLine?: number }> {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  return diff.split(/\r?\n/).map((text) => {
    const kind = diffLineKind(text);
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { text, kind };
    }
    if (kind === 'is-meta') return { text, kind };
    if (kind === 'is-add') {
      const result = { text, kind, newLine };
      if (newLine !== undefined) newLine += 1;
      return result;
    }
    if (kind === 'is-delete') {
      const result = { text, kind, oldLine };
      if (oldLine !== undefined) oldLine += 1;
      return result;
    }
    const result = { text, kind, oldLine, newLine };
    if (oldLine !== undefined) oldLine += 1;
    if (newLine !== undefined) newLine += 1;
    return result;
  });
}

function taskDocumentFiles(deposition: TaskAssetDeposition, item: AssetMergeItem): TaskChangedFile[] {
  const selectedPaths = new Set(item.source_items);
  return deposition.changed_files.filter((file) => (
    file.category === 'document' && selectedPaths.has(file.path) && file.operation !== 'deleted'
  ));
}

function safeWikiFilename(path: string): string {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('__')
    .replace(/[^\p{L}\p{N}._-]/gu, '_');
}

function notebookAsMarkdown(path: string, content: string): string {
  try {
    const notebook = JSON.parse(content) as { cells?: Array<{ cell_type?: string; source?: string | string[] }> };
    const body = (notebook.cells ?? []).map((cell, index) => {
      const text = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '');
      return cell.cell_type === 'code'
        ? `## 代码单元 ${index + 1}\n\n\`\`\`python\n${text}\n\`\`\``
        : text;
    }).join('\n\n');
    return `# ${path}\n\n${body}\n`;
  } catch {
    return `# ${path}\n\n\`\`\`json\n${content}\n\`\`\`\n`;
  }
}

function taskFileAsWikiSource(file: TaskChangedFile): { filename: string; content: string } {
  if (file.content === undefined) throw new Error(`任务产物未保存修改后文档全文：${file.path}`);
  const filename = safeWikiFilename(file.path);
  const lowerPath = file.path.toLowerCase();
  if (lowerPath.endsWith('.md') || lowerPath.endsWith('.txt')) {
    return { filename, content: file.content };
  }
  if (lowerPath.endsWith('.ipynb')) {
    return { filename: `${filename}.md`, content: notebookAsMarkdown(file.path, file.content) };
  }
  if (lowerPath.endsWith('.rst')) {
    return {
      filename: `${filename}.md`,
      content: `# ${file.path}\n\n来源：\`${file.path}\`\n\n\`\`\`rst\n${file.content}\n\`\`\`\n`,
    };
  }
  return {
    filename: `${filename}.md`,
    content: `# ${file.path}\n\n来源：\`${file.path}\`\n\n\`\`\`text\n${file.content}\n\`\`\`\n`,
  };
}

async function readWikiSnapshot(wikiId: string): Promise<WikiPageSnapshot> {
  const pages = await knowledgeApi.wiki.pages(wikiId);
  const refs = pages.map((page) => page.id ?? page.path).filter(Boolean);
  const contentByRef = new Map<string, string>();
  for (let offset = 0; offset < refs.length; offset += 20) {
    const result = await knowledgeApi.wiki.readMany(wikiId, refs.slice(offset, offset + 20));
    for (const page of result.items ?? []) {
      if (!page.not_found) contentByRef.set(page.ref, page.content ?? '');
    }
  }
  return { pages, contentByRef };
}

function wikiRefsForSources(snapshot: WikiPageSnapshot, filenames: string[]): string[] {
  return Array.from(snapshot.contentByRef.entries())
    .filter(([, content]) => {
      const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
      return filenames.some((filename) => frontmatter.includes(filename));
    })
    .map(([ref]) => ref);
}

function contributionSearchTerms(files: TaskChangedFile[]): string[] {
  const candidates = files.flatMap((file) => (file.diff ?? '').split(/\r?\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .flatMap((line) => line.slice(1).match(/[\p{L}_][\p{L}\p{N}_-]{3,}/gu) ?? []));
  return Array.from(new Set(candidates))
    .sort((left, right) => Number(right.includes('_')) - Number(left.includes('_')) || right.length - left.length)
    .slice(0, 5);
}

export default function AssetDepositionPanel({
  taskId,
  teamId,
  currentUser,
  deposition,
  canEdit,
  onChange,
}: {
  taskId: string;
  teamId: string;
  currentUser: string;
  deposition: TaskAssetDeposition;
  canEdit: boolean;
  onChange: (next: TaskAssetDeposition) => Promise<void>;
}) {
  const [wikiAssets, setWikiAssets] = useState<WikiDetail[]>([]);
  const [codeAssets, setCodeAssets] = useState<CodeGraphDetail[]>([]);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, AssetPreview>>({});

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      knowledgeApi.wiki.teamAssets(teamId).catch(() => [] as WikiDetail[]),
      knowledgeApi.code.teamAssets(teamId).catch(() => [] as CodeGraphDetail[]),
    ]).then(([wikis, graphs]) => {
      if (!cancelled) {
        setWikiAssets(wikis);
        setCodeAssets(graphs);
      }
    });
    return () => { cancelled = true; };
  }, [teamId]);

  const verificationPassed = useMemo(
    () => deposition.verification.length > 0 && deposition.verification.every((item) => item.status === 'passed'),
    [deposition.verification],
  );
  const verificationFailed = useMemo(
    () => deposition.verification.some((item) => item.status === 'failed'),
    [deposition.verification],
  );

  async function persistItemPatch(itemId: string, patch: Partial<AssetMergeItem>) {
    const next: TaskAssetDeposition = {
      ...deposition,
      merge_items: deposition.merge_items.map((item) => item.item_id === itemId ? { ...item, ...patch } : item),
      updated_at: new Date().toISOString(),
    };
    await onChange(next);
  }

  async function patchItem(itemId: string, patch: Partial<AssetMergeItem>) {
    setBusyItem(itemId);
    try {
      await persistItemPatch(itemId, patch);
    } finally {
      setBusyItem(null);
    }
  }

  async function selectTarget(item: AssetMergeItem, assetId: string) {
    if (!assetId) {
      await patchItem(item.item_id, {
        target_asset_id: undefined,
        target_name: item.asset_type === 'llm_wiki' ? '项目 Wiki' : '项目代码图谱',
        baseline_version: undefined,
        result_version: undefined,
        contribution: undefined,
        status: 'pending_review',
        error: undefined,
      });
      return;
    }
    const assets = item.asset_type === 'llm_wiki' ? wikiAssets : codeAssets;
    const target = assets.find((asset) => (
      item.asset_type === 'llm_wiki'
        ? (asset as WikiDetail).wiki_id === assetId
        : (asset as CodeGraphDetail).code_graph_id === assetId
    ));
    if (!target) return;
    await patchItem(item.item_id, {
      target_asset_id: assetId,
      target_name: item.asset_type === 'llm_wiki'
        ? (target as WikiDetail).name
        : (target as CodeGraphDetail).repo_name,
      baseline_version: target.version,
      ...(item.target_asset_id !== assetId ? {
        result_version: undefined,
        contribution: undefined,
        status: 'pending_review' as const,
        error: undefined,
      } : {}),
    });
  }

  async function createTaskSnapshotCodeGraph(item: AssetMergeItem) {
    const canonicalProject = canonicalProjectFromUrl(deposition.project.repo_url);
    if (!canonicalProject) {
      tea.notify.error('当前仅支持为 github.com 的公开仓库创建 Task 快照 CKG。');
      return;
    }
    const patch = assembleTaskPatch(deposition.changed_files);
    if (!patch.trim()) {
      tea.notify.error('本次 Task 没有可用于创建仓库快照的 Git Diff。');
      return;
    }
    const confirmed = await tea.confirm({
      message: '新增 Task 快照 CKG？',
      description: `系统会把验证通过的结果发布到受控的公开 GitHub 快照分支，并为 ${canonicalProject} 创建一份独立代码图谱。该操作不会修改原项目仓库。`,
      okText: '上传快照并创建',
      cancelText: '取消',
    });
    if (!confirmed) return;

    setBusyItem(item.item_id);
    try {
      const created = await knowledgeApi.code.createTaskSnapshot({
        teamId,
        taskId,
        sourceRepoUrl: deposition.project.repo_url,
        canonicalProject,
        baseCommit: deposition.artifact_bundle.base_commit,
        patch,
      });
      let graph = created.code_graph;
      for (let attempt = 0; attempt < 180; attempt += 1) {
        if (graph.status === 'ready' || graph.status === 'failed') break;
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        graph = await knowledgeApi.code.get(graph.code_graph_id);
      }
      if (graph.status === 'failed') throw new Error(graph.sync_error ?? 'Task 快照 CKG 构建失败。');
      if (graph.status !== 'ready') throw new Error('Task 快照 CKG 构建超时，可稍后重试。');
      await knowledgeApi.code.registerMeta(teamId, graph.code_graph_id);
      const taskChange = await knowledgeApi.code.buildTaskDiff({
        teamId,
        taskId,
        codeGraphId: graph.code_graph_id,
        baseCommit: deposition.artifact_bundle.base_commit,
        resultCommit: created.snapshot.commit,
        patch,
      });
      const nextItem: AssetMergeItem = {
        ...item,
        target_asset_id: graph.code_graph_id,
        target_name: graph.repo_name,
        baseline_version: undefined,
        result_version: graph.commit_hash ?? graph.version,
        result_commit: created.snapshot.commit,
        expected_commit: created.snapshot.commit,
        task_snapshot: {
          repo_url: created.snapshot.repoUrl,
          branch: created.snapshot.branch,
          commit: created.snapshot.commit,
          canonical_project: created.snapshot.canonicalProject,
        },
        contribution: {
          ...item.contribution,
          source_paths: item.source_items,
          code_entities: taskChange.diff.entities.map((entity) => ({
            name: entity.name,
            kind: entity.kind as CodeEntityKind,
            path: entity.path,
          })),
        },
        status: taskChange.status === 'merged' ? 'merged' : 'approved',
        error: undefined,
      };
      const next: TaskAssetDeposition = {
        ...deposition,
        artifact_bundle: {
          ...deposition.artifact_bundle,
          result_commit: created.snapshot.commit,
        },
        merge_items: deposition.merge_items.map((candidate) => candidate.item_id === item.item_id ? nextItem : candidate),
        updated_at: new Date().toISOString(),
      };
      setCodeAssets((current) => [
        ...current.filter((candidate) => candidate.code_graph_id !== graph.code_graph_id),
        graph,
      ]);
      setPreviews((current) => ({
        ...current,
        [item.item_id]: { loading: false, codeGraph: graph, taskCodeGraphChange: taskChange },
      }));
      await onChange(next);
      tea.notify.success('Task 结果已发布为独立仓库快照，新的项目代码图谱已沉淀。');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await persistItemPatch(item.item_id, {
        status: item.status === 'merged' ? 'merged' : 'failed',
        error: message,
      });
      tea.notify.error(message);
    } finally {
      setBusyItem(null);
    }
  }

  async function publishWiki(item: AssetMergeItem) {
    if (!item.target_asset_id) return;
    const documents = taskDocumentFiles(deposition, item);
    if (documents.length === 0) {
      await patchItem(item.item_id, { status: 'failed', error: '本次 Task 没有可写入 Wiki 的文档变更。' });
      return;
    }
    const missingContent = documents.find((file) => file.content === undefined);
    if (missingContent) {
      await patchItem(item.item_id, {
        status: 'failed',
        error: `任务产物只保存了差异，缺少修改后的文档全文：${missingContent.path}。请重新采集任务产物后再沉淀。`,
      });
      return;
    }
    const confirmed = await tea.confirm({
      message: `确认将 ${documents.length} 份文档更新到项目 Wiki？`,
      description: '系统将写入本次 Task 修改后的文档全文，重新生成 Wiki，并记录实际新增或变化的知识页面。',
      okText: '批准并沉淀',
      cancelText: '取消',
    });
    if (!confirmed) return;

    setBusyItem(item.item_id);
    try {
      const before = await readWikiSnapshot(item.target_asset_id);
      const sources = documents.map(taskFileAsWikiSource);
      await persistItemPatch(item.item_id, { status: 'publishing', error: undefined });
      for (let offset = 0; offset < sources.length; offset += 10) {
        await knowledgeApi.wiki.uploadMany(teamId, item.target_asset_id, sources.slice(offset, offset + 10));
      }
      try {
        await knowledgeApi.wiki.ingest(item.target_asset_id);
      } catch (err) {
        // Wiki 已经处于生成中时，继续轮询现有任务；其它错误需要立即暴露。
        if (!(err instanceof Error && /409|busy/i.test(err.message))) throw err;
      }

      let detail: WikiDetail | undefined;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, attempt === 0 ? 800 : 2000));
        detail = await knowledgeApi.wiki.get(item.target_asset_id);
        if (detail.status === 'pending' || detail.status === 'processing') continue;
        if (detail.status === 'failed') throw new Error(detail.sync_error ?? '项目 Wiki 生成失败');
        if (detail.status === 'ready') break;
      }
      if (!detail || detail.status !== 'ready') throw new Error('项目 Wiki 生成超时，请稍后重试。');

      const after = await readWikiSnapshot(item.target_asset_id);
      let contributionRefs = wikiRefsForSources(after, sources.map((source) => source.filename));

      // 兼容尚未在页面 frontmatter 中保存 sources 的 Wiki 实现：退化为比较
      // ingest 前后的实际页面内容，而不是展示任意几个已有页面。
      if (contributionRefs.length === 0) {
        contributionRefs = Array.from(after.contentByRef.entries())
          .filter(([ref, content]) => before.contentByRef.get(ref) !== content)
          .map(([ref]) => ref);
      }

      // 若目标 Wiki 已经包含相同文档，增量 ingest 可能没有页面变化。此时根据
      // 本次新增文本中的标识符检索对应页面，记录“复用已有知识”的归因关系。
      if (contributionRefs.length === 0) {
        const matched = new Set<string>();
        for (const term of contributionSearchTerms(documents)) {
          const search = await knowledgeApi.wiki.search(item.target_asset_id, term, 10);
          for (const result of search.results ?? []) matched.add(result.path);
        }
        contributionRefs.push(...matched);
      }

      const nextItem: AssetMergeItem = {
        ...item,
        status: 'merged',
        result_version: detail.version,
        contribution: {
          ...item.contribution,
          source_paths: documents.map((file) => file.path),
          wiki_page_refs: contributionRefs,
        },
        error: undefined,
      };
      await persistItemPatch(item.item_id, nextItem);
      setWikiAssets((current) => current.map((wiki) => wiki.wiki_id === detail!.wiki_id ? detail! : wiki));
      await loadAssetPreview(nextItem, true);
      tea.notify.success(`项目 Wiki 已更新，本次 Task 关联 ${contributionRefs.length} 个知识页面。`);
    } catch (err) {
      await persistItemPatch(item.item_id, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      tea.notify.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyItem(null);
    }
  }

  async function readExtractedSkills(item: AssetMergeItem): Promise<SkillSummary[]> {
    const receipt = item.skill_extraction;
    if (!receipt) return [];
    const result = await listSkills({
      user_id: currentUser,
      team_id: teamId,
      agent_id: receipt.agent_id,
      filters: { owner_agent_id: receipt.agent_id, status: ['active'] },
      pagination: { limit: 100, offset: 0 },
    });
    const requestedAt = Date.parse(receipt.requested_at);
    return result.items.filter((skill) => {
      // 新版 Core 保存业务 Task ID；兼容旧版错误保存归档任务 ID 的数据。
      if (skill.task_id === taskId || skill.task_id === receipt.archive_task_id) return true;
      const baseline = receipt.baseline_versions[skill.skill_id];
      const changedSinceRequest = baseline === undefined || skill.version > baseline;
      return changedSinceRequest && skill.updated_at_ms >= requestedAt;
    });
  }

  async function finishSkillExtraction(item: AssetMergeItem, skills: SkillSummary[]) {
    const details = await Promise.all(skills.map((skill) => getSkill({
      user_id: currentUser,
      team_id: teamId,
      skill_id: skill.skill_id,
      include_content: true,
      include_manifest: true,
    })));
    const nextItem: AssetMergeItem = {
      ...item,
      target_asset_id: skills[0]?.skill_id,
      target_name: skills.map((skill) => skill.name).join('、') || '团队 Skill',
      status: 'merged',
      contribution: {
        ...item.contribution,
        skill_ids: skills.map((skill) => skill.skill_id),
        skill_names: Object.fromEntries(skills.map((skill) => [skill.skill_id, skill.name])),
      },
      error: undefined,
    };
    await persistItemPatch(item.item_id, nextItem);
    setPreviews((current) => ({
      ...current,
      [item.item_id]: { loading: false, skills: details },
    }));
    tea.notify.success(`已从会话中沉淀 ${skills.length} 个 Skill。`);
  }

  async function waitForSkillExtraction(item: AssetMergeItem): Promise<boolean> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 2000));
      const skills = await readExtractedSkills(item);
      if (skills.length > 0) {
        await finishSkillExtraction(item, skills);
        return true;
      }
    }
    return false;
  }

  async function publishSkill(item: AssetMergeItem) {
    const sessions = deposition.artifact_bundle.sessions ?? [];
    const session = sessions.find((candidate) => candidate.messages.length > 0);
    const agentId = deposition.artifact_bundle.agent_id;
    if (!session) {
      await patchItem(item.item_id, {
        status: 'failed',
        error: '任务没有保存可提取的结构化会话，请先重新采集 Agent 运行产物。',
      });
      return;
    }
    if (!agentId) {
      await patchItem(item.item_id, {
        status: 'failed',
        error: '任务没有记录实际执行 Agent，无法确定 Skill 的归属。',
      });
      return;
    }

    if (item.skill_extraction) {
      setBusyItem(item.item_id);
      try {
        const completed = await waitForSkillExtraction(item);
        if (!completed) tea.notify.warning('Skill 仍在后台提取，可稍后点击“检查提取结果”。');
      } catch (err) {
        tea.notify.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyItem(null);
      }
      return;
    }

    const confirmed = await tea.confirm({
      message: '确认从本次 Agent 会话中提取团队 Skill？',
      description: `系统将把 ${session.harness} 的 ${session.message_count} 条结构化消息交给现有 Skill 提取器，由提取器判断是否新增或更新可复用 Skill。`,
      okText: '批准并沉淀',
      cancelText: '取消',
    });
    if (!confirmed) return;

    setBusyItem(item.item_id);
    try {
      const baseline = await listSkills({
        user_id: currentUser,
        team_id: teamId,
        agent_id: agentId,
        filters: { owner_agent_id: agentId, status: ['active'] },
        pagination: { limit: 100, offset: 0 },
      });
      const requestedAt = new Date().toISOString();
      const result = await extractSkills({
        user_id: currentUser,
        team_id: teamId,
        agent_id: agentId,
        task_id: taskId,
        session_id: session.session_id,
        messages: session.messages.map((entry) => ({
          role: entry.role,
          content: entry.content,
          tool_name: entry.tool_name,
          tool_call_id: entry.tool_call_id,
        })),
        reason: [
          'A human reviewer has approved this completed software-engineering session for team asset deposition. ',
          'The reviewer has confirmed that it contains reusable value. You MUST persist at least one skill and MUST NOT return Nothing to save. ',
          'Extract transferable repository exploration, API design, compatibility handling, test validation, or debugging procedures, ',
          'and durable project knowledge useful for later maintenance. Parameterize run-specific values and use the existing library for deduplication.',
        ].join(''),
        options: { max_iterations: 16 },
      });
      const requestedItem: AssetMergeItem = {
        ...item,
        status: 'publishing',
        skill_extraction: {
          archive_task_id: result.task_id,
          agent_id: agentId,
          requested_at: requestedAt,
          baseline_versions: Object.fromEntries(baseline.items.map((skill) => [skill.skill_id, skill.version])),
        },
        error: undefined,
      };
      await persistItemPatch(item.item_id, requestedItem);
      tea.notify.success('会话已提交，TDAI 正在提取 Skill。');
      const completed = await waitForSkillExtraction(requestedItem);
      if (!completed) tea.notify.warning('Skill 仍在后台提取，可稍后点击“检查提取结果”。');
    } catch (err) {
      await persistItemPatch(item.item_id, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      tea.notify.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyItem(null);
    }
  }

  async function publish(item: AssetMergeItem) {
    if (item.asset_type === 'skill') {
      await publishSkill(item);
      return;
    }
    if (!item.target_asset_id) {
      tea.notify.warning('请先选择需要更新的团队资产。');
      return;
    }
    if (item.asset_type === 'code_graph') {
      setBusyItem(item.item_id);
      try {
        const taskChange = await knowledgeApi.code.buildTaskDiff({
          teamId,
          taskId,
          codeGraphId: item.target_asset_id,
          baseCommit: deposition.artifact_bundle.base_commit,
          resultCommit: deposition.artifact_bundle.result_commit ?? item.result_commit,
          patch: assembleTaskPatch(deposition.changed_files),
        });
        await patchItem(item.item_id, {
          status: taskChange.status === 'merged' ? 'merged' : 'approved',
          error: undefined,
        });
        setPreviews((current) => ({
          ...current,
          [item.item_id]: {
            ...(current[item.item_id] ?? { loading: false }),
            taskCodeGraphChange: taskChange,
          },
        }));
        tea.notify.success(taskChange.status === 'merged'
          ? '任务代码贡献已关联到项目图谱。'
          : '已生成任务代码差异；项目图谱尚未同步。');
      } catch (err) {
        await patchItem(item.item_id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
      } finally {
        setBusyItem(null);
      }
      return;
    }
    if (item.asset_type === 'llm_wiki') await publishWiki(item);
  }

  async function syncMergedCodeGraph(item: AssetMergeItem) {
    if (!item.target_asset_id) return;
    const confirmed = await tea.confirm({
      message: '确认任务代码已进入项目分支？',
      description: '系统将拉取所选代码仓库的当前分支并重建项目代码图谱，然后把本次 Task 的贡献关联到图谱。提交经过 squash 或 rebase 时，将以本次人工确认为合并依据。',
      okText: '确认并更新图谱',
      cancelText: '取消',
    });
    if (!confirmed) return;
    setBusyItem(item.item_id);
    try {
      await knowledgeApi.code.sync(item.target_asset_id);
      await patchItem(item.item_id, { status: 'publishing', error: undefined });
      for (let attempt = 0; attempt < 90; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        const graph = await knowledgeApi.code.get(item.target_asset_id);
        if (graph.status === 'pending' || graph.status === 'processing') continue;
        if (graph.status === 'failed') {
          throw new Error(graph.sync_error ?? '项目图谱同步失败');
        }
        let taskChange = await knowledgeApi.code.getTaskDiff(taskId, item.target_asset_id);
        // result_commit 通常来自 Agent 的临时工作区；真实合并可能经过 squash、
        // rebase 或 cherry-pick，因此它不一定是远端分支 HEAD 的祖先。用户在此处
        // 已明确确认代码完成合并，自动 Git 校验未命中时保留这项人工合并证据。
        if (taskChange.status !== 'merged') {
          taskChange = await knowledgeApi.code.updateTaskDiffStatus(
            taskId,
            item.target_asset_id,
            'merged',
          );
        }
        setPreviews((current) => ({
          ...current,
          [item.item_id]: {
            ...(current[item.item_id] ?? { loading: false }),
            codeGraph: graph,
            taskCodeGraphChange: taskChange,
          },
        }));
        await patchItem(item.item_id, {
          status: 'merged',
          result_version: graph.commit_hash ?? graph.version,
          error: undefined,
        });
        tea.notify.success('项目图谱已更新，任务贡献已关联到正式图谱节点。');
        return;
      }
      throw new Error('项目图谱同步超时，请稍后重新打开任务查看状态');
    } catch (err) {
      await patchItem(item.item_id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusyItem(null);
    }
  }

  async function loadAssetPreview(item: AssetMergeItem, force = false) {
    if ((!force && previews[item.item_id]) || !item.target_asset_id) return;
    setPreviews((current) => ({ ...current, [item.item_id]: { loading: true } }));
    try {
      if (item.asset_type === 'llm_wiki') {
        const [wikiPages, wikiGraph, raw] = await Promise.all([
          knowledgeApi.wiki.pages(item.target_asset_id),
          knowledgeApi.wiki.graph(item.target_asset_id),
          knowledgeApi.wiki.rawList(item.target_asset_id),
        ]);
        const contributedRefs = new Set(item.contribution?.wiki_page_refs ?? []);
        const samplePages = wikiPages
          .filter((page) => contributedRefs.has(page.id ?? page.path))
          .slice(0, 3);
        const wikiSamples = await Promise.all(samplePages.map(async (page) => ({
          path: page.path,
          title: page.title || page.path,
          content: (await knowledgeApi.wiki.read(item.target_asset_id!, page.path)).content,
        })));
        setPreviews((current) => ({
          ...current,
          [item.item_id]: { loading: false, wikiPages, wikiGraph, wikiRawFiles: raw.files, wikiSamples },
        }));
      } else if (item.asset_type === 'code_graph') {
        const taskCodeGraphChange = await knowledgeApi.code
          .getTaskDiff(taskId, item.target_asset_id)
          .catch(() => undefined);
        const query = taskCodeGraphChange?.diff.entities[0]?.name
          ?? item.contribution?.code_entities?.[0]?.name
          ?? item.source_items[0]
          ?? '';
        const [codeGraph, search] = await Promise.all([
          knowledgeApi.code.get(item.target_asset_id),
          // 文件不是 CKG 实体类型；不指定 kind，由服务在所有合法实体类型中检索。
          knowledgeApi.code.search(item.target_asset_id, query, undefined, 8),
        ]);
        setPreviews((current) => ({
          ...current,
          [item.item_id]: {
            loading: false,
            codeGraph,
            codeGraphText: search.isError ? undefined : search.text,
            taskCodeGraphChange,
          },
        }));
      } else if (item.asset_type === 'skill') {
        const skillIds = item.contribution?.skill_ids
          ?? (item.target_asset_id ? [item.target_asset_id] : []);
        const skills = await Promise.all(skillIds.map((skillId) => getSkill({
          user_id: currentUser,
          team_id: teamId,
          skill_id: skillId,
          include_content: true,
          include_manifest: true,
        })));
        setPreviews((current) => ({
          ...current,
          [item.item_id]: { loading: false, skills },
        }));
      }
    } catch (err) {
      setPreviews((current) => ({
        ...current,
        [item.item_id]: { loading: false, error: err instanceof Error ? err.message : String(err) },
      }));
    }
  }

  function renderAssetContent(item: AssetMergeItem) {
    const preview = previews[item.item_id];
    if (item.asset_type === 'task_bundle') {
      return (
        <div className="_memory-deposition-content-grid">
          <div><strong>会话记录</strong><span>{deposition.artifact_bundle.session_ids.length} 次 Agent 执行</span></div>
          <div><strong>实现变更</strong><span>{deposition.changed_files.length} 个文件</span></div>
          <div><strong>验证记录</strong><span>{deposition.verification.length} 组测试结果</span></div>
          <div><strong>保存内容</strong><span>任务说明、补丁、测试日志和会话索引</span></div>
        </div>
      );
    }

    if (item.asset_type === 'skill') {
      const sessions = deposition.artifact_bundle.sessions ?? [];
      return (
        <div className="_memory-deposition-skill-preview">
          {sessions.map((session) => (
            <section key={session.session_id} className="_memory-deposition-session">
              <div className="_memory-deposition-session-head">
                <div>
                  <strong>{session.harness}</strong>
                  {session.model && <span>{session.model}</span>}
                </div>
                <div className="_memory-deposition-session-metrics">
                  <span>{session.message_count} 条消息</span>
                  {typeof session.turns === 'number' && <span>{session.turns} 轮</span>}
                  <span>{session.tools.length} 类工具</span>
                </div>
              </div>
              <div className="_memory-deposition-session-stream">
                {session.messages.map((entry, index) => {
                  const isTool = entry.role === 'tool_call' || entry.role === 'tool_result';
                  const header = (
                    <>
                      <span className={`role-${entry.role}`}>{SESSION_ROLE_LABEL[entry.role]}</span>
                      {entry.tool_name && <code>{entry.tool_name}</code>}
                      {entry.status && <small>{entry.status}</small>}
                      {entry.truncated && <small>内容已压缩</small>}
                    </>
                  );
                  return isTool ? (
                    <details key={`${entry.role}:${entry.tool_call_id ?? index}:${index}`} className="_memory-deposition-session-message is-tool">
                      <summary>{header}</summary>
                      <pre>{entry.content}</pre>
                    </details>
                  ) : (
                    <div key={`${entry.role}:${index}`} className="_memory-deposition-session-message">
                      <div className="_memory-deposition-session-message-head">{header}</div>
                      <pre>{entry.content}</pre>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
          {sessions.length === 0 && (
            <div className="_memory-deposition-empty-content">
              当前任务只记录了 Session ID，尚未保存可展示的结构化会话。请重新采集任务产物。
            </div>
          )}
          {item.status === 'publishing' && (
            <div className="_memory-deposition-skill-progress">会话已提交，TDAI 正在后台归纳可复用 Skill。</div>
          )}
          {(preview?.skills ?? []).length > 0 && (
            <div className="_memory-deposition-extracted-skills">
              <div className="_memory-deposition-preview-label">已沉淀 Skill</div>
              {preview!.skills!.map((skill) => (
                <article key={skill.skill_id}>
                  <div><strong>{skill.name}</strong><span>v{skill.version}</span></div>
                  {skill.description && <p>{skill.description}</p>}
                  <pre>{skill.content}</pre>
                </article>
              ))}
            </div>
          )}
        </div>
      );
    }

    if (!item.target_asset_id) {
      return (
        <div className="_memory-deposition-source-preview">
          <p>尚未生成或选择项目资产。当前可用于生成资产的内容：</p>
          <ul>{item.source_items.map((source) => <li key={source}><code>{source}</code></li>)}</ul>
        </div>
      );
    }

    if (!preview || preview.loading) return <div className="_memory-deposition-empty-content">正在读取资产内容…</div>;
    if (preview.error) return <div className="_memory-deposition-error">资产内容读取失败：{preview.error}</div>;

    if (item.asset_type === 'llm_wiki') {
      const contributedRefs = item.contribution?.wiki_page_refs ?? [];
      const documents = taskDocumentFiles(deposition, item);
      return (
        <div className="_memory-deposition-asset-preview">
          <div className="_memory-deposition-preview-label">
            本次 Task {item.status === 'merged' ? '已沉淀' : '待沉淀'}文档
          </div>
          <div className="_memory-deposition-wiki-documents">
            {documents.map((file) => (
              <details key={file.path}>
                <summary>
                  <span className={`_memory-deposition-kind kind-${file.category}`}>{OPERATION_LABEL[file.operation]}</span>
                  <code>{file.path}</code>
                  <small>{file.content === undefined ? '缺少修改后全文' : '已保存修改后全文'}</small>
                </summary>
                {file.content !== undefined ? (
                  <pre>{file.content.slice(0, 12000)}</pre>
                ) : (
                  <div className="_memory-deposition-error">当前只有 diff，无法作为 Wiki 来源文档发布。</div>
                )}
              </details>
            ))}
            {documents.length === 0 && <div className="_memory-deposition-empty-content">本次 Task 没有文档变更。</div>}
          </div>

          <div className="_memory-deposition-preview-label">项目 Wiki 当前内容</div>
          <div className="_memory-deposition-content-grid">
            <div><strong>知识页面</strong><span>{preview.wikiPages?.length ?? 0} 页</span></div>
            <div><strong>来源文档</strong><span>{preview.wikiRawFiles?.length ?? 0} 份</span></div>
          </div>
          {preview.wikiGraph && (
            <>
              <KnowledgeGraph
                data={preview.wikiGraph}
                highlightNodes={contributedRefs}
                compact
                className="_memory-deposition-wiki-graph"
              />
            </>
          )}
          {contributedRefs.length > 0 && (
            <>
              <div className="_memory-deposition-preview-label">
                本次 Task 生成或关联的知识页面（{contributedRefs.length}）
              </div>
              <div className="_memory-deposition-sample-list">
                {(preview.wikiSamples ?? []).map((sample) => (
                  <div key={sample.path}>
                    <strong>{sample.title}</strong>
                    <pre>{sample.content.slice(0, 1000)}</pre>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="_memory-deposition-preview-label">项目 Wiki 的全部来源文档</div>
          <ul>{(preview.wikiRawFiles ?? []).map((file) => <li key={file.filename}><code>{file.filename}</code></li>)}</ul>
        </div>
      );
    }

    const stats = preview.codeGraph?.stats;
    const taskChange = preview.taskCodeGraphChange;
    const codeEntities = taskChange?.diff.entities
      ?? (item.contribution?.code_entities ?? []).map((entity) => ({ ...entity, change_type: 'added' as const }));
    const changeLabel = { added: '新增', modified: '修改', deleted: '删除' } as const;
    return (
      <div className="_memory-deposition-asset-preview">
        <div className="_memory-deposition-content-grid is-three">
          <div><strong>文件</strong><span>{stats?.files ?? 0}</span></div>
          <div><strong>代码节点</strong><span>{stats?.nodes ?? 0}</span></div>
          <div><strong>关系</strong><span>{stats?.edges ?? 0}</span></div>
        </div>
        <div className="_memory-deposition-preview-label">本次 Task 贡献的代码实体</div>
        {taskChange && (
          <div className="_memory-deposition-task-diff-summary">
            <span>{taskChange.status === 'merged' ? '已进入项目图谱' : taskChange.status === 'obsolete' ? '已失效' : '待代码合并'}</span>
            <strong>{taskChange.diff.summary.files} 个文件</strong>
            <strong>{taskChange.diff.summary.entities} 个实体</strong>
            <strong>{taskChange.diff.summary.relations} 条关系变化</strong>
          </div>
        )}
        {codeEntities.length > 0 ? (
          <div className="_memory-deposition-code-contribution">
            {codeEntities.map((entity) => (
              <div key={'stable_key' in entity ? entity.stable_key : `${entity.path ?? ''}:${entity.name}`}>
                <span className={`change-${entity.change_type}`}>{changeLabel[entity.change_type]}</span>
                <strong>{entity.name}</strong>
                {entity.path && <code>{entity.path}</code>}
              </div>
            ))}
          </div>
        ) : (
          <p className="_memory-deposition-more">当前记录未包含实体级贡献标记。</p>
        )}
        {(taskChange?.diff.relations.length ?? 0) > 0 && (
          <>
            <div className="_memory-deposition-preview-label">本次 Task 改变的代码关系</div>
            <div className="_memory-deposition-relation-list">
              {taskChange!.diff.relations.slice(0, 30).map((relation) => (
                <div key={relation.stable_key}>
                  <span className={`change-${relation.change_type}`}>{changeLabel[relation.change_type]}</span>
                  <code>{relation.source}</code>
                  <span>{relation.kind === 'calls' ? '调用' : relation.kind === 'imports' ? '导入' : '继承'}</span>
                  <code>{relation.target}</code>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="_memory-deposition-preview-label">本次 Task 纳入图谱的变更来源</div>
        <ul>{item.source_items.map((source) => <li key={source}><code>{source}</code></li>)}</ul>
        {item.task_snapshot && (
          <div className="_memory-deposition-snapshot-source">
            <div className="_memory-deposition-preview-label">Task 仓库快照</div>
            <div><strong>项目</strong><span>{item.task_snapshot.canonical_project}</span></div>
            <div><strong>仓库</strong><span>{item.task_snapshot.repo_url}</span></div>
            <div><strong>分支</strong><code>{item.task_snapshot.branch}</code></div>
          </div>
        )}
        {preview.codeGraphText && (
          <>
            <div className="_memory-deposition-preview-label">图谱内容示例</div>
            <pre className="_memory-deposition-code-preview">{preview.codeGraphText.slice(0, 2000)}</pre>
          </>
        )}
      </div>
    );
  }

  return (
    <section className="_memory-deposition">
      <div className="_memory-deposition-title-row">
        <div className="_memory-deposition-heading">
          <span className="_memory-deposition-heading-icon"><Package size={18} /></span>
          <div>
            <Text theme="strong" className="_memory-deposition-title">本次任务沉淀的资产</Text>
          </div>
        </div>
        <span className={`_memory-deposition-verify ${verificationPassed ? 'is-pass' : 'is-warn'}`}>
          {verificationPassed ? <CircleCheck size={14} /> : <CircleX size={14} />}
          {verificationPassed ? '验证通过' : verificationFailed ? '验证未通过' : '验证未完成'}
        </span>
      </div>

      <div className="_memory-deposition-summary">
        <div><span className="_memory-deposition-metric-icon icon-project"><Files size={17} /></span><span>项目</span><strong>{deposition.project.name}</strong></div>
        <div><span className="_memory-deposition-metric-icon icon-version"><FileCode2 size={17} /></span><span>变更文件</span><strong>{deposition.changed_files.length} 个</strong></div>
        <div><span className="_memory-deposition-metric-icon icon-agent"><Bot size={17} /></span><span>执行工具</span><strong>{deposition.artifact_bundle.harness}</strong></div>
        <div><span className="_memory-deposition-metric-icon icon-session"><Package size={17} /></span><span>会话记录</span><strong>{deposition.artifact_bundle.session_ids.length} 次</strong></div>
      </div>

      {deposition.execution && (
        <div className={`_memory-deposition-execution ${deposition.execution.status === 'completed' ? 'is-pass' : 'is-warn'}`}>
          <strong>{deposition.execution.status === 'completed' ? 'Agent 执行完成' : 'Agent 执行异常'}</strong>
          <span>{deposition.execution.summary}</span>
        </div>
      )}

      <div className="_memory-deposition-file-counts">
        {(['code', 'document', 'test', 'config', 'other'] as const).map((category) => {
          const count = countFiles(deposition.changed_files, category);
          const Icon = CATEGORY_ICON[category];
          return count > 0 ? <span key={category}><Icon size={13} />{CATEGORY_LABEL[category]} <b>{count}</b></span> : null;
        })}
      </div>

      <details className="_memory-deposition-files">
        <summary>查看变更文件（{deposition.changed_files.length}）</summary>
        <div className="_memory-deposition-diff-list">
          {deposition.changed_files.map((file) => (
            <details key={file.path} className="_memory-deposition-diff-file" open={deposition.changed_files.length === 1}>
              <summary>
                <span className={`_memory-deposition-kind kind-${file.category}`}>{CATEGORY_LABEL[file.category]}</span>
                <span className="_memory-deposition-operation">{OPERATION_LABEL[file.operation]}</span>
                <code>{file.path}</code>
                {(typeof file.additions === 'number' || typeof file.deletions === 'number') && (
                  <span className="_memory-deposition-diff-stat">
                    <b>+{file.additions ?? 0}</b><i>−{file.deletions ?? 0}</i>
                  </span>
                )}
              </summary>
              {file.diff ? (
                <pre className="_memory-deposition-diff">
                  {parseDiffLines(file.diff).map((line, index) => (
                    <span key={`${index}:${line.text.slice(0, 24)}`} className={line.kind}>
                      <em>{line.oldLine ?? ''}</em><em>{line.newLine ?? ''}</em><code>{line.text || ' '}</code>
                    </span>
                  ))}
                </pre>
              ) : (
                <div className="_memory-deposition-empty-content">该历史记录尚未保存逐文件差异。</div>
              )}
            </details>
          ))}
        </div>
      </details>

      <div className="_memory-deposition-section-title"><FlaskConical size={15} />验证结果</div>
      <div className="_memory-deposition-verifications">
        {deposition.verification.map((item) => (
          <details key={item.command} className="_memory-deposition-verification">
            <summary>
              <span className={`_memory-deposition-test-icon ${item.status === 'passed' ? 'is-pass' : 'is-warn'}`}>
                {item.status === 'passed' ? <CircleCheck size={17} /> : <CircleX size={17} />}
              </span>
              <div><code>{item.command}</code><span>点击查看具体测试用例</span></div>
              <div className="_memory-deposition-test-counts">
                <b className="is-pass">{item.passed} 通过</b>
                <b className={item.failed > 0 ? 'is-fail' : ''}>{item.failed} 失败</b>
                {typeof item.skipped === 'number' && <b>{item.skipped} 跳过</b>}
              </div>
            </summary>
            <div className="_memory-deposition-test-cases">
              {(item.tests ?? []).length > 0 ? item.tests?.map((test) => (
                <div key={test.node_id} className={`status-${test.status}`}>
                  <span>{test.status === 'passed' ? '通过' : test.status === 'failed' ? '失败' : '跳过'}</span>
                  <div><strong>{test.name}</strong><code>{test.node_id}</code></div>
                  {typeof test.duration_ms === 'number' && <small>{test.duration_ms} ms</small>}
                  {test.detail && <pre>{test.detail}</pre>}
                </div>
              )) : <div className="_memory-deposition-empty-content">该历史记录只有汇总结果，尚未保存测试用例明细。</div>}
            </div>
          </details>
        ))}
      </div>

      <div className="_memory-deposition-plan-title">资产内容与状态</div>
      <div className="_memory-deposition-plan">
        {deposition.merge_items.filter((item) => item.asset_type !== 'task_bundle').map((item) => {
          const selectable = (item.asset_type === 'llm_wiki' || item.asset_type === 'code_graph')
            && ['pending_review', 'approved', 'conflict', 'failed'].includes(item.status);
          const options = item.asset_type === 'llm_wiki' ? wikiAssets : codeAssets;
          const TypeIcon = TYPE_ICON[item.asset_type];
          return (
            <div className="_memory-deposition-item" key={item.item_id}>
              <div className="_memory-deposition-item-head">
                <div className={`_memory-deposition-item-title type-${item.asset_type}`}>
                  <span><TypeIcon size={16} /></span>
                  <strong>{TYPE_LABEL[item.asset_type]}</strong>
                </div>
                <span className={`_memory-deposition-status status-${item.status}`}>{STATUS_LABEL[item.status]}</span>
              </div>
              {selectable && (
                <label className="_memory-deposition-target">
                  <span>更新到</span>
                  <select
                    value={item.target_asset_id ?? ''}
                    disabled={!canEdit || busyItem === item.item_id}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (item.asset_type === 'code_graph' && value === NEW_TASK_SNAPSHOT_CKG) {
                        void createTaskSnapshotCodeGraph(item);
                      } else {
                        void selectTarget(item, value);
                      }
                    }}
                  >
                    <option value="">请选择团队已有资产</option>
                    {item.asset_type === 'code_graph' && (
                      <option value={NEW_TASK_SNAPSHOT_CKG}>＋ 新增 Task 快照 CKG</option>
                    )}
                    {options.map((asset) => {
                      const id = item.asset_type === 'llm_wiki'
                        ? (asset as WikiDetail).wiki_id
                        : (asset as CodeGraphDetail).code_graph_id;
                      const name = item.asset_type === 'llm_wiki'
                        ? (asset as WikiDetail).name
                        : `${(asset as CodeGraphDetail).repo_name} / ${(asset as CodeGraphDetail).branch}`;
                      return <option key={id} value={id}>{name}</option>;
                    })}
                  </select>
                </label>
              )}
              <details
                className="_memory-deposition-content"
                onToggle={(event) => {
                  if (event.currentTarget.open) void loadAssetPreview(item);
                }}
              >
                <summary>查看资产内容</summary>
                {renderAssetContent(item)}
              </details>
              {item.error && <div className="_memory-deposition-error">{item.error}</div>}
              {canEdit
                && item.asset_type === 'code_graph'
                && item.status === 'merged'
                && !item.task_snapshot && (
                <div className="_memory-deposition-actions">
                  <Button type="primary" disabled={busyItem === item.item_id} onClick={() => void createTaskSnapshotCodeGraph(item)}>
                    另存为 Task 快照 CKG
                  </Button>
                </div>
              )}
              {canEdit && item.asset_type === 'skill' && item.status === 'publishing' && (
                <div className="_memory-deposition-actions">
                  <Button type="primary" disabled={busyItem === item.item_id} onClick={() => void publish(item)}>
                    检查提取结果
                  </Button>
                </div>
              )}
              {canEdit && !['saved', 'merged', 'blocked', 'skipped', 'publishing'].includes(item.status) && (
                <div className="_memory-deposition-actions">
                  <Button type="primary" disabled={busyItem === item.item_id} onClick={() => void publish(item)}>
                    {item.asset_type === 'code_graph' ? '生成贡献差异' : '批准并沉淀'}
                  </Button>
                  {item.asset_type === 'code_graph'
                    && (item.status === 'approved' || item.status === 'conflict')
                    && (deposition.artifact_bundle.result_commit || item.result_commit) && (
                    <Button disabled={busyItem === item.item_id} onClick={() => void syncMergedCodeGraph(item)}>
                      确认已合并并更新图谱
                    </Button>
                  )}
                  <Button disabled={busyItem === item.item_id} onClick={() => void patchItem(item.item_id, { status: 'skipped', error: undefined })}>不沉淀</Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
