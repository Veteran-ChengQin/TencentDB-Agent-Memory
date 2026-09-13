import assert from 'node:assert/strict';
import test from 'node:test';

import { parseJUnit, validateRunContext, validateRunManifest } from './task-run-finalizer.mjs';
import { normalizeAgentSession } from './normalize-agent-session.mjs';

test('parseJUnit aggregates cases and preserves failure details', () => {
  const xml = `<?xml version="1.0"?>
  <testsuites><testsuite tests="3" failures="1" errors="0" skipped="1">
    <testcase classname="tests.test_api" name="test_ok" time="0.01" />
    <testcase classname="tests.test_api" name="test_bad" time="0.02"><failure>expected &lt;A&gt;</failure></testcase>
    <testcase classname="tests.test_api" name="test_skip"><skipped>offline</skipped></testcase>
  </testsuite></testsuites>`;
  const result = parseJUnit(xml, 'pytest F2P');
  assert.equal(result.status, 'failed');
  assert.equal(result.passed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.tests[1].detail, 'expected <A>');
});

test('parseJUnit accepts a passing suite', () => {
  const result = parseJUnit('<testsuites><testsuite tests="2" failures="0" errors="0" skipped="0"><testcase name="a"/><testcase name="b"/></testsuite></testsuites>');
  assert.equal(result.status, 'passed');
  assert.equal(result.passed, 2);
});

test('run manifest requires an explicit supported task kind', () => {
  assert.throws(
    () => validateRunManifest({ schema_version: 1, workspace: '.', runtime_dir: '.' }),
    /task_kind must be feature or bug/,
  );
  assert.doesNotThrow(() => validateRunManifest({
    schema_version: 1,
    task_kind: 'bug',
    workspace: '.',
    runtime_dir: '.',
  }));
});

test('TDAI run context requires stable task ownership identifiers', () => {
  assert.throws(() => validateRunContext({ team_id: 'team-a', task_id: 'task-a' }), /agent_id/);
  assert.doesNotThrow(() => validateRunContext({
    team_id: 'team-a',
    task_id: 'task-a',
    agent_id: 'agent-a',
  }));
});

test('normalizes Codex JSONL into a reusable session', () => {
  const transcript = [
    { type: 'thread.started', thread_id: 'codex-thread' },
    { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '已定位问题。' } },
    { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'pytest -q', aggregated_output: '1 passed', exit_code: 0, status: 'completed' } },
  ].map(JSON.stringify).join('\n');
  const result = normalizeAgentSession({
    session: { session_id: 'codex-thread', harness: 'Codex CLI', model: 'model-a', outcome: 'completed' },
    transcript,
    taskPrompt: '修复问题',
  });
  assert.equal(result.source_format, 'codex-jsonl');
  assert.ok(result.messages.some((item) => item.role === 'tool_call' && item.tool_name === 'shell'));
});

test('normalizes CodeBuddy JSONL and retains a terminal execution error', () => {
  const transcript = [
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: '开始修改。' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '上游服务中断' }] } },
    { type: 'result', is_error: true, errors: ['上游服务中断'] },
  ].map(JSON.stringify).join('\n');
  const result = normalizeAgentSession({
    session: { session_id: 'codebuddy-session', harness: 'CodeBuddy Code', model: 'model-b', outcome: 'failed' },
    transcript,
    taskPrompt: '实现功能',
  });
  assert.equal(result.source_format, 'codebuddy-jsonl');
  assert.ok(result.messages.some((item) => item.content === '上游服务中断' && item.status === 'failed'));
  assert.ok(result.messages.every((item) => item.content !== 'private'));
});
