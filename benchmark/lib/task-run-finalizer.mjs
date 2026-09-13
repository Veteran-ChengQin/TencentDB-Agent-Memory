import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { normalizeAgentSession } from './normalize-agent-session.mjs';

const execFile = promisify(execFileCallback);
const moduleDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moduleDir, '../..');

function decodeXml(value) {
  return String(value ?? '')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function xmlAttribute(attributes, name) {
  return decodeXml(attributes.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1] ?? '');
}

export function parseJUnit(xml, command = 'pytest') {
  const suites = [...String(xml).matchAll(/<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/g)];
  if (suites.length === 0) {
    return { command, passed: 0, failed: 1, skipped: 0, status: 'failed', tests: [] };
  }

  let total = 0;
  let failed = 0;
  let skipped = 0;
  const tests = [];
  for (const suite of suites) {
    const attributes = suite[1] ?? '';
    total += Number(xmlAttribute(attributes, 'tests') || 0);
    failed += Number(xmlAttribute(attributes, 'failures') || 0)
      + Number(xmlAttribute(attributes, 'errors') || 0);
    skipped += Number(xmlAttribute(attributes, 'skipped') || 0);

    const body = suite[2] ?? '';
    const pattern = /<testcase\b([^>]*)\/>|<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;
    for (const match of body.matchAll(pattern)) {
      const caseAttributes = match[1] ?? match[2] ?? '';
      const caseBody = match[3] ?? '';
      const name = xmlAttribute(caseAttributes, 'name') || 'unknown';
      const className = xmlAttribute(caseAttributes, 'classname');
      const status = /<(?:failure|error)\b/.test(caseBody)
        ? 'failed'
        : /<skipped\b/.test(caseBody) ? 'skipped' : 'passed';
      const detail = caseBody.match(/<(?:failure|error|skipped)\b[^>]*>([\s\S]*?)<\/(?:failure|error|skipped)>/)?.[1];
      const durationSeconds = Number(xmlAttribute(caseAttributes, 'time'));
      tests.push({
        node_id: [className, name].filter(Boolean).join('::'),
        name,
        status,
        ...(Number.isFinite(durationSeconds) ? { duration_ms: Math.round(durationSeconds * 1_000) } : {}),
        ...(detail ? { detail: decodeXml(detail.replace(/<[^>]+>/g, '')).trim().slice(0, 12_000) } : {}),
      });
    }
  }

  return {
    command,
    passed: Math.max(0, total - failed - skipped),
    failed,
    skipped,
    status: failed === 0 ? 'passed' : 'failed',
    tests,
  };
}

function classifyFile(path) {
  if (/(^|\/)(tests?|testing)(\/|$)|(^|\/)test_[^/]+\.py$/i.test(path)) return 'test';
  if (/^(doc|docs)\/|\.(md|rst|ipynb|txt)$/i.test(path)) return 'document';
  if (/(^|\/)(\.github|ci|config)(\/|$)|\.(ya?ml|toml|ini|cfg|json)$/i.test(path)) return 'config';
  if (/\.(py|js|ts|tsx|jsx|java|go|rs|cpp|c|h|hpp|cs|kt|swift|rb|php)$/i.test(path)) return 'code';
  return 'other';
}

async function git(workspace, ...args) {
  const result = await execFile('git', ['-C', workspace, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return result.stdout.replace(/[\r\n]+$/, '');
}

async function gitRaw(workspace, ...args) {
  const result = await execFile('git', ['-C', workspace, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return result.stdout;
}

async function readText(path) {
  const buffer = await readFile(path);
  return buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
    ? buffer.subarray(2).toString('utf16le')
    : buffer.toString('utf8').replace(/^\uFEFF/, '');
}

function pathFrom(baseDir, value) {
  if (!value) return undefined;
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

async function readOptional(path) {
  if (!path) return undefined;
  try { return await readText(path); } catch { return undefined; }
}

async function collectChangedFiles(workspace) {
  // Git patches are interchange artifacts. Preserve their final line feed;
  // the trimmed helper is only suitable for scalar output such as rev-parse.
  const fullDiff = await gitRaw(workspace, 'diff', '--binary', '--', '.');
  const diffByPath = new Map();
  for (const section of fullDiff.split(/(?=^diff --git )/m).filter(Boolean)) {
    const match = section.match(/^diff --git a\/(.+) b\/(.+)$/m);
    if (match) diffByPath.set(match[2], section);
  }

  const porcelain = await git(workspace, 'status', '--porcelain=v1');
  const changedFiles = [];
  for (const line of porcelain.split(/\r?\n/).filter(Boolean)) {
    const code = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    const path = (rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1) : rawPath).replaceAll('\\', '/');
    const operation = code.includes('R') ? 'renamed'
      : code.includes('D') ? 'deleted'
        : code.includes('A') || code === '??' ? 'added' : 'modified';
    let diff = diffByPath.get(path);
    let content;

    if (operation === 'added' && !diff) {
      const added = await readOptional(resolve(workspace, path));
      if (added !== undefined && !added.includes('\0')) {
        const lines = added.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
        diff = [
          `diff --git a/${path} b/${path}`,
          'new file mode 100644',
          '--- /dev/null',
          `+++ b/${path}`,
          `@@ -0,0 +1,${lines.length} @@`,
          ...lines.map((item) => `+${item}`),
        ].join('\n');
      }
    }

    const category = classifyFile(path);
    if (category === 'document' && operation !== 'deleted') {
      try {
        const buffer = await readFile(resolve(workspace, path));
        if (buffer.length <= 512 * 1024 && !buffer.includes(0)) content = buffer.toString('utf8');
      } catch { /* The diff remains reviewable when the final document cannot be read. */ }
    }

    const additions = diff?.split(/\r?\n/).filter((item) => item.startsWith('+') && !item.startsWith('+++')).length;
    const deletions = diff?.split(/\r?\n/).filter((item) => item.startsWith('-') && !item.startsWith('---')).length;
    changedFiles.push({
      path,
      category,
      operation,
      ...(diff ? { diff, additions, deletions } : {}),
      ...(content !== undefined ? { content } : {}),
    });
  }

  return { fullDiff, changedFiles };
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '-').slice(-48);
}

function assetStatus({ sourceItems, verificationPassed }) {
  if (sourceItems.length === 0) return 'skipped';
  return verificationPassed ? 'pending_review' : 'blocked';
}

function assetError({ assetType, sourceItems, verificationPassed }) {
  if (sourceItems.length === 0) {
    if (assetType === 'llm_wiki') return '本次任务没有文档变更，未生成项目 Wiki 候选。';
    if (assetType === 'code_graph') return '本次任务没有代码或测试变更，未生成代码图谱候选。';
    return '本次运行没有可用于提取 Skill 的会话内容。';
  }
  if (!verificationPassed) return '验证未全部通过，暂不允许沉淀到团队资产。';
  return undefined;
}

function buildMergeItems({ session, changedFiles, resultCommit, verificationPassed }) {
  const suffix = safeId(session.session_id);
  const definitions = [
    {
      asset_type: 'llm_wiki',
      target_name: '项目 Wiki',
      action_summary: '将本次任务修改后的文档合并到团队项目 Wiki。',
      source_items: changedFiles.filter((file) => file.category === 'document').map((file) => file.path),
    },
    {
      asset_type: 'code_graph',
      target_name: '项目代码图谱',
      action_summary: '根据任务前后的代码差异生成可追溯的代码图谱贡献。',
      source_items: changedFiles.filter((file) => ['code', 'test'].includes(file.category)).map((file) => file.path),
      expected_commit: resultCommit,
    },
    {
      asset_type: 'skill',
      target_name: '团队 Skill',
      action_summary: '从本次 Agent 会话中提取可跨任务复用的工程经验。',
      source_items: session.messages.length > 0 ? [`${session.harness} Session ${session.session_id}`] : [],
    },
  ];

  return definitions.map((definition) => {
    const status = assetStatus({ sourceItems: definition.source_items, verificationPassed });
    const error = assetError({
      assetType: definition.asset_type,
      sourceItems: definition.source_items,
      verificationPassed,
    });
    return {
      item_id: `${definition.asset_type}-${suffix}`,
      ...definition,
      status,
      ...(error ? { error } : {}),
    };
  });
}

function artifactUri(path) {
  const rel = relative(repositoryRoot, path).replaceAll('\\', '/');
  return rel.startsWith('..') ? path.replaceAll('\\', '/') : rel;
}

async function loadVerification(entries, runtimeDir) {
  return Promise.all((entries ?? []).map(async (entry) => {
    const junitPath = pathFrom(runtimeDir, entry.junit_file);
    const xml = await readOptional(junitPath);
    if (xml === undefined) {
      return {
        command: entry.command || entry.name || '验证',
        passed: 0,
        failed: 0,
        skipped: 0,
        status: 'not_run',
        tests: [],
        ...(junitPath ? { result_uri: artifactUri(junitPath) } : {}),
      };
    }
    return {
      ...parseJUnit(xml, entry.command || entry.name || '验证'),
      result_uri: artifactUri(junitPath),
    };
  }));
}

function inferProjectName(repoUrl) {
  const tail = String(repoUrl ?? '').replace(/[\/#]+$/, '').split('/').at(-1) || '项目';
  return tail.replace(/\.git$/i, '');
}

export function validateRunManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('run manifest must be a JSON object.');
  }
  if (manifest.schema_version !== 1) throw new Error('run manifest schema_version must be 1.');
  if (!['feature', 'bug'].includes(manifest.task_kind)) {
    throw new Error('run manifest task_kind must be feature or bug.');
  }
  if (!manifest.workspace || !manifest.runtime_dir) {
    throw new Error('run manifest workspace and runtime_dir are required.');
  }
}

export function validateRunContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('tdai-context.json must contain a JSON object.');
  }
  for (const field of ['team_id', 'task_id', 'agent_id']) {
    if (!context[field]) throw new Error(`tdai-context.json is missing ${field}.`);
  }
}

export async function buildTaskDeposition({ manifest, manifestDir }) {
  validateRunManifest(manifest);
  const workspace = pathFrom(manifestDir, manifest.workspace);
  const runtimeDir = pathFrom(manifestDir, manifest.runtime_dir);
  const contextPath = pathFrom(runtimeDir, manifest.context_file || 'tdai-context.json');
  const summaryPath = pathFrom(runtimeDir, manifest.session?.summary_file || 'agent-session.json');
  const transcriptPath = pathFrom(runtimeDir, manifest.session?.transcript_file || 'agent-session.jsonl');
  const legacySummaryPath = pathFrom(runtimeDir, 'codebuddy-session.json');
  const legacyTranscriptPath = pathFrom(runtimeDir, 'codebuddy-session.jsonl');
  const instructionPath = pathFrom(manifestDir, manifest.instruction_file);

  const context = JSON.parse(await readText(contextPath));
  validateRunContext(context);
  const summaryText = await readOptional(summaryPath) ?? await readOptional(legacySummaryPath);
  const transcript = await readOptional(transcriptPath) ?? await readOptional(legacyTranscriptPath);
  if (!summaryText) throw new Error('Agent session summary is missing.');
  if (transcript === undefined) throw new Error('Agent session transcript is missing.');
  const sessionSummary = JSON.parse(summaryText);
  const taskPrompt = await readOptional(instructionPath) ?? '';
  const session = normalizeAgentSession({ session: sessionSummary, transcript, taskPrompt });
  const { fullDiff, changedFiles } = await collectChangedFiles(workspace);
  const baseCommit = manifest.base_commit || await git(workspace, 'rev-parse', 'HEAD');
  const resultCommit = manifest.result_commit
    || `worktree:${createHash('sha256').update(fullDiff).digest('hex').slice(0, 16)}`;
  const verification = await loadVerification(manifest.verification, runtimeDir);
  const executionPassed = sessionSummary.outcome === 'completed' && Number(sessionSummary.exit_code ?? 0) === 0;
  const verificationPassed = verification.length > 0 && verification.every((item) => item.status === 'passed');
  const now = new Date().toISOString();
  const patchPath = pathFrom(runtimeDir, manifest.patch_file || 'change.patch');
  const resultLogPath = pathFrom(runtimeDir, manifest.test_result_file || 'test-results.log');
  const depositionPath = pathFrom(runtimeDir, manifest.deposition_file || 'asset-deposition.json');

  await mkdir(runtimeDir, { recursive: true });
  await writeFile(patchPath, fullDiff, 'utf8');

  const project = {
    name: manifest.project?.name || inferProjectName(manifest.project?.repo_url),
    repo_url: manifest.project?.repo_url || '',
    branch: manifest.project?.branch || await git(workspace, 'branch', '--show-current'),
  };
  const deposition = {
    schema_version: 1,
    task_kind: manifest.task_kind,
    project,
    execution: {
      status: executionPassed ? 'completed' : 'failed',
      summary: executionPassed
        ? `${session.harness} 已正常完成任务。`
        : `${session.harness} 执行未正常完成。`,
      ...(typeof session.turns === 'number' ? { turns: session.turns } : {}),
    },
    artifact_bundle: {
      harness: session.harness,
      agent_id: context.agent_id,
      base_commit: baseCommit,
      result_commit: resultCommit,
      session_ids: [session.session_id],
      sessions: [session],
      manifest_uri: artifactUri(depositionPath),
      patch_uri: artifactUri(patchPath),
      ...(resultLogPath ? { test_result_uri: artifactUri(resultLogPath) } : {}),
      captured_at: now,
    },
    changed_files: changedFiles,
    verification,
    merge_items: buildMergeItems({ session, changedFiles, resultCommit, verificationPassed }),
    updated_at: now,
  };

  return {
    context,
    sessionSummary,
    deposition,
    depositionPath,
    verificationPassed,
    executionPassed,
  };
}

async function postMeta({ coreBase, instanceId, userKey }, action, body) {
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
  if (!response.ok || envelope.code !== 0) {
    throw new Error(`${action}: ${envelope.message ?? response.statusText}`);
  }
  return envelope.data;
}

export async function finalizeTaskRun({ manifest, manifestDir, dryRun = false }) {
  const built = await buildTaskDeposition({ manifest, manifestDir });
  await writeFile(built.depositionPath, `${JSON.stringify(built.deposition, null, 2)}\n`, 'utf8');
  if (dryRun) return { ...built, task: undefined };

  const coreBase = process.env.TDAI_CORE_URL || manifest.tdai?.core_url || 'http://127.0.0.1:8420/v3/meta';
  const keyPath = pathFrom(manifestDir, process.env.TDAI_USER_KEY_FILE || manifest.tdai?.user_key_file)
    || resolve(repositoryRoot, 'deploy/global-images/.admin-key');
  const userKey = process.env.TDAI_USER_KEY?.trim() || (await readText(keyPath)).trim();
  const api = { coreBase, instanceId: built.context.instance_id || 'default', userKey };
  const task = await postMeta(api, 'task/get', { task_id: built.context.task_id });
  let metadata = {};
  try { metadata = JSON.parse(task.metadata_json || '{}'); } catch { /* Preserve a valid metadata object. */ }

  const finalizedSessionIds = Array.isArray(metadata.finalized_session_ids) ? metadata.finalized_session_ids : [];
  if (!finalizedSessionIds.includes(built.sessionSummary.session_id)) {
    await postMeta(api, 'participation-log/append', {
      team_id: built.context.team_id || task.team_id,
      task_id: task.task_id,
      agent_id: built.context.agent_id,
      user_id: built.context.user_id || task.creator_user_id,
      source: 'task-run-finalizer',
      metadata_json: JSON.stringify({
        session_id: built.sessionSummary.session_id,
        harness: built.sessionSummary.harness,
        model: built.sessionSummary.model,
        execution_passed: built.executionPassed,
        verification_passed: built.verificationPassed,
      }),
    });
    finalizedSessionIds.push(built.sessionSummary.session_id);
  }

  const priorRuns = Array.isArray(metadata.task_runs) ? metadata.task_runs : [];
  const runRecord = {
    session_id: built.sessionSummary.session_id,
    harness: built.sessionSummary.harness,
    model: built.sessionSummary.model,
    execution_status: built.deposition.execution.status,
    verification_passed: built.verificationPassed,
    artifact_manifest_uri: built.deposition.artifact_bundle.manifest_uri,
    finalized_at: built.deposition.updated_at,
  };
  metadata.asset_deposition = built.deposition;
  metadata.finalized_session_ids = finalizedSessionIds;
  metadata.task_runs = [...priorRuns.filter((item) => item?.session_id !== runRecord.session_id), runRecord].slice(-20);
  if (manifest.task_kind) {
    metadata.asset_usage = { ...(metadata.asset_usage ?? {}), task_kind: manifest.task_kind };
  }

  const updatedTask = await postMeta(api, 'task/update', {
    task_id: task.task_id,
    status: 'completed',
    metadata_json: JSON.stringify(metadata),
  });
  return { ...built, task: updatedTask };
}

function parseArgs(argv) {
  const result = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--dry-run') result.dryRun = true;
    else if (value === '--manifest') result.manifestPath = argv[++index];
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifestPath) throw new Error('Usage: node task-run-finalizer.mjs --manifest <run-manifest.json> [--dry-run]');
  const manifestPath = resolve(args.manifestPath);
  const manifest = JSON.parse(await readText(manifestPath));
  const result = await finalizeTaskRun({ manifest, manifestDir: dirname(manifestPath), dryRun: args.dryRun });
  console.log(JSON.stringify({
    task_id: result.context.task_id,
    session_id: result.sessionSummary.session_id,
    harness: result.sessionSummary.harness,
    task_status: args.dryRun ? 'not_updated' : result.task?.status,
    execution_passed: result.executionPassed,
    verification_passed: result.verificationPassed,
    changed_files: result.deposition.changed_files.length,
    deposition_file: result.depositionPath,
  }, null, 2));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
