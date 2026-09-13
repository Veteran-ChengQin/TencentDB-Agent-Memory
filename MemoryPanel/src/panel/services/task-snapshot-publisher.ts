import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MAX_PATCH_BYTES = 5 * 1024 * 1024;
const GITHUB_API = 'https://api.github.com';
const DEFAULT_SNAPSHOT_EXCLUDED_PATHS = '.github/workflows';

export interface PublishTaskSnapshotInput {
  taskId: string;
  sourceRepoUrl: string;
  canonicalProject: string;
  baseCommit: string;
  patch: string;
  taskTitle?: string;
}

export interface PublishedTaskSnapshot {
  repoUrl: string;
  repository: string;
  branch: string;
  commit: string;
  canonicalProject: string;
}

export interface TaskSnapshotPublisherConfig {
  owner: string;
  token: string;
  gitUserName: string;
  gitUserEmail: string;
  repositoryPrefix: string;
  excludedPaths: string[];
}

export function parseSnapshotExcludedPaths(value?: string): string[] {
  const paths = (value?.trim() || DEFAULT_SNAPSHOT_EXCLUDED_PATHS)
    .split(',')
    .map((path) => path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter(Boolean);

  const invalid = paths.find((path) => (
    path.startsWith('/') || path.split('/').some((segment) => segment === '.' || segment === '..')
  ));
  if (invalid) throw new Error(`Task 快照排除路径必须是仓库内的相对路径：${invalid}`);
  return [...new Set(paths)];
}

/**
 * Normalise transport differences without changing patch hunk contents.
 * A Git patch must end with a line feed even when the changed source file
 * intentionally has no newline at EOF.
 */
export function normalizeGitPatch(patch: string): string {
  const normalized = patch.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized) return '';
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

function safeSegment(value: string, maxLength = 80): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);
}

export function canonicalProjectFromRepoUrl(repoUrl: string): string | undefined {
  try {
    const url = new URL(repoUrl);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return undefined;
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
    if (parts.length !== 2 || parts.some((part) => !part)) return undefined;
    return `${parts[0]}/${parts[1]}`;
  } catch {
    return undefined;
  }
}

export function snapshotRepositoryName(prefix: string, canonicalProject: string): string {
  const project = safeSegment(canonicalProject.replace('/', '-'), 70);
  const normalizedPrefix = safeSegment(prefix, 20) || 'tdai-snapshot';
  return `${normalizedPrefix}-${project}`.slice(0, 100);
}

export function snapshotBranchName(taskId: string, patch: string): string {
  const task = safeSegment(taskId, 60) || 'task';
  const digest = createHash('sha256').update(normalizeGitPatch(patch)).digest('hex').slice(0, 12);
  return `tdai/${task}/${digest}`;
}

function patchPaths(patch: string): string[] {
  return [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)]
    .flatMap((match) => [match[1], match[2]])
    .filter((path): path is string => typeof path === 'string');
}

export function validateSnapshotInput(input: PublishTaskSnapshotInput): void {
  const patch = normalizeGitPatch(input.patch);
  if (!/^task-[A-Za-z0-9_-]+$/.test(input.taskId)) throw new Error('Task ID 格式无效。');
  const sourceProject = canonicalProjectFromRepoUrl(input.sourceRepoUrl);
  if (!sourceProject) throw new Error('Task 快照目前只支持 github.com 的公开 HTTPS 仓库。');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.canonicalProject)) {
    throw new Error('项目标识必须使用 owner/repository 格式。');
  }
  if (sourceProject.toLowerCase() !== input.canonicalProject.toLowerCase()) {
    throw new Error('项目标识与源仓库 URL 不一致。');
  }
  if (!/^[0-9a-f]{7,40}$/i.test(input.baseCommit)) throw new Error('Base Commit 必须是 Git SHA。');
  if (!patch.trim()) throw new Error('任务没有可上传的 Git Patch。');
  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) throw new Error('Git Patch 超过 5 MiB。');

  const paths = patchPaths(patch);
  if (paths.length === 0) throw new Error('Git Patch 中没有可识别的变更文件。');
  const forbidden = paths.find((rawPath) => {
    const path = rawPath.replace(/\\/g, '/').toLowerCase();
    const segments = path.split('/');
    const file = segments.at(-1) ?? '';
    return segments.some((segment) => ['.git', '.codebuddy', '.codex', 'node_modules', 'artifacts'].includes(segment))
      || file === '.env'
      || file.startsWith('.env.')
      || /\.(?:pem|key|p12|pfx)$/i.test(file)
      || /(?:credential|secret|token)/i.test(file);
  });
  if (forbidden) throw new Error(`快照包含禁止上传的敏感或运行时文件：${forbidden}`);
}

function loadConfig(): TaskSnapshotPublisherConfig {
  const owner = process.env.TDAI_SNAPSHOT_GITHUB_OWNER?.trim() ?? '';
  const token = process.env.TDAI_SNAPSHOT_GITHUB_TOKEN?.trim() ?? '';
  if (!owner || !token) {
    throw new Error('未配置 Task 快照托管。请设置 TDAI_SNAPSHOT_GITHUB_OWNER 和 TDAI_SNAPSHOT_GITHUB_TOKEN。');
  }
  return {
    owner,
    token,
    gitUserName: process.env.TDAI_SNAPSHOT_GIT_USER_NAME?.trim() || 'TDAI Snapshot Bot',
    gitUserEmail: process.env.TDAI_SNAPSHOT_GIT_USER_EMAIL?.trim() || 'tdai-snapshot@localhost',
    repositoryPrefix: process.env.TDAI_SNAPSHOT_REPO_PREFIX?.trim() || 'tdai-snapshot',
    excludedPaths: parseSnapshotExcludedPaths(process.env.TDAI_SNAPSHOT_EXCLUDED_PATHS),
  };
}

async function githubRequest<T>(config: TaskSnapshotPublisherConfig, path: string, init: RequestInit = {}): Promise<{ status: number; data?: T }> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${config.token}`,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) as T & { message?: string } : undefined;
  if (!response.ok && response.status !== 404) {
    const message = data && typeof data === 'object' && 'message' in data ? String(data.message) : response.statusText;
    throw new Error(`GitHub API 请求失败（${response.status}）：${message}`);
  }
  return { status: response.status, data };
}

async function ensurePublicRepository(config: TaskSnapshotPublisherConfig, repository: string): Promise<void> {
  const existing = await githubRequest<{ private?: boolean }>(config, `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(repository)}`);
  if (existing.status === 200) {
    if (existing.data?.private) throw new Error('快照仓库是私有仓库；当前 CKG 只支持公开 HTTPS 仓库。');
    return;
  }

  const viewer = await githubRequest<{ login?: string }>(config, '/user');
  const isUserOwner = viewer.data?.login?.toLowerCase() === config.owner.toLowerCase();
  const endpoint = isUserOwner ? '/user/repos' : `/orgs/${encodeURIComponent(config.owner)}/repos`;
  await githubRequest(config, endpoint, {
    method: 'POST',
    body: JSON.stringify({
      name: repository,
      description: 'TDAI Task result snapshots used to build team code graphs.',
      private: false,
      auto_init: false,
      has_issues: false,
      has_projects: false,
      has_wiki: false,
    }),
  });
}

async function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFile('git', args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout.trim();
}

export async function publishTaskSnapshot(input: PublishTaskSnapshotInput): Promise<PublishedTaskSnapshot> {
  const patch = normalizeGitPatch(input.patch);
  validateSnapshotInput({ ...input, patch });
  const config = loadConfig();
  const repository = snapshotRepositoryName(config.repositoryPrefix, input.canonicalProject);
  const branch = snapshotBranchName(input.taskId, patch);
  await ensurePublicRepository(config, repository);

  const temp = await mkdtemp(join(tmpdir(), 'tdai-task-snapshot-'));
  try {
    const patchPath = join(temp, 'task.patch');
    const messagePath = join(temp, 'commit-message.txt');
    const askPassPath = join(temp, 'git-askpass.sh');
    await writeFile(patchPath, patch, { encoding: 'utf8', mode: 0o600 });
    await writeFile(messagePath, [
      `TDAI snapshot for ${input.taskId}`,
      '',
      input.taskTitle?.trim() || 'Task result snapshot',
      `Canonical-Project: ${input.canonicalProject}`,
      `Base-Commit: ${input.baseCommit}`,
    ].join('\n'), { encoding: 'utf8', mode: 0o600 });
    await writeFile(askPassPath, [
      '#!/bin/sh',
      'case "$1" in',
      '  *Username*) printf "%s\\n" "$TDAI_GITHUB_USERNAME" ;;',
      '  *) printf "%s\\n" "$TDAI_GITHUB_TOKEN" ;;',
      'esac',
    ].join('\n'), { encoding: 'utf8', mode: 0o700 });
    await chmod(askPassPath, 0o700);

    await runGit(temp, ['init']);
    await runGit(temp, ['remote', 'add', 'source', input.sourceRepoUrl]);
    await runGit(temp, ['fetch', '--depth', '1', 'source', input.baseCommit]);
    await runGit(temp, ['checkout', '--detach', 'FETCH_HEAD']);
    await runGit(temp, ['apply', '--check', '--binary', '--whitespace=nowarn', patchPath]);
    await runGit(temp, ['apply', '--binary', '--whitespace=nowarn', patchPath]);
    await runGit(temp, ['add', '--all']);
    // Snapshot repositories are read-only CKG inputs, not CI execution
    // targets. Excluding workflow definitions keeps the publisher token on
    // least-privilege Contents access and prevents imported workflows from
    // becoming executable in the managed public repository.
    for (const excludedPath of config.excludedPaths) {
      await runGit(temp, ['rm', '-r', '--cached', '--ignore-unmatch', '--', excludedPath]);
    }
    const tree = await runGit(temp, ['write-tree']);
    const repoUrl = `https://github.com/${config.owner}/${repository}.git`;
    const pushEnv = {
      GIT_ASKPASS: askPassPath,
      GIT_TERMINAL_PROMPT: '0',
      TDAI_GITHUB_USERNAME: config.owner,
      TDAI_GITHUB_TOKEN: config.token,
    };
    await runGit(temp, ['remote', 'add', 'snapshot', repoUrl]);

    // Retries are expected when CKG ingestion or the browser is interrupted.
    // Reuse an existing immutable snapshot only when its complete tree matches.
    const remoteRef = await runGit(temp, ['ls-remote', '--heads', 'snapshot', `refs/heads/${branch}`], pushEnv);
    if (remoteRef) {
      const remoteCommit = remoteRef.split(/\s+/)[0];
      if (!remoteCommit) throw new Error(`无法解析远端 Task 快照引用：${branch}`);
      await runGit(temp, ['fetch', '--depth', '1', 'snapshot', remoteCommit], pushEnv);
      const remoteTree = await runGit(temp, ['rev-parse', `${remoteCommit}^{tree}`]);
      if (remoteTree !== tree) {
        throw new Error(`Task 快照分支已存在，但内容与当前结果不一致：${branch}`);
      }
      return { repoUrl, repository, branch, commit: remoteCommit, canonicalProject: input.canonicalProject };
    }

    const commit = await runGit(temp, [
      '-c', `user.name=${config.gitUserName}`,
      '-c', `user.email=${config.gitUserEmail}`,
      'commit-tree', tree, '-F', messagePath,
    ]);

    await runGit(temp, ['push', 'snapshot', `${commit}:refs/heads/${branch}`], pushEnv);

    return { repoUrl, repository, branch, commit, canonicalProject: input.canonicalProject };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
