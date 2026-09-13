/**
 * Convert agent-specific JSONL transcripts into the message shape accepted by
 * TDAI `/v3/skill/extract`. The normalized trace is also stored with the Task
 * so the Workbench can render the real session without reading local files.
 */

const TOOL_CONTENT_LIMIT = 6_000;
const MESSAGE_CONTENT_LIMIT = 16_000;
const TOTAL_CONTENT_LIMIT = 320_000;

function asText(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function truncateMiddle(value, limit) {
  const text = asText(value).trim();
  if (text.length <= limit) return { content: text, truncated: false };
  const marker = `\n\n… 已省略 ${text.length - limit} 个字符 …\n\n`;
  const available = Math.max(2, limit - marker.length);
  const head = Math.ceil(available * 0.65);
  return {
    content: `${text.slice(0, head)}${marker}${text.slice(-(available - head))}`,
    truncated: true,
    original_chars: text.length,
  };
}

function message(role, content, extra = {}) {
  const limit = role === 'tool_call' || role === 'tool_result'
    ? TOOL_CONTENT_LIMIT
    : MESSAGE_CONTENT_LIMIT;
  const shortened = truncateMiddle(content, limit);
  if (!shortened.content) return undefined;
  return { role, ...shortened, ...extra };
}

function codexMessages(events) {
  const output = [];
  for (const event of events) {
    if (event?.type !== 'item.completed' || !event.item) continue;
    const item = event.item;
    if (item.type === 'agent_message') {
      output.push(message('assistant', item.text));
      continue;
    }
    if (item.type === 'command_execution') {
      output.push(message('tool_call', item.command, {
        tool_name: 'shell',
        tool_call_id: item.id,
      }));
      output.push(message('tool_result', item.aggregated_output || `命令结束，退出码 ${item.exit_code ?? '未知'}`, {
        tool_name: 'shell',
        tool_call_id: item.id,
        status: item.status,
      }));
      continue;
    }
    if (item.type === 'file_change') {
      const changes = (item.changes ?? []).map((change) => `${change.kind ?? '修改'} ${change.path}`).join('\n');
      output.push(message('tool_call', changes || '应用文件变更', {
        tool_name: 'apply_patch',
        tool_call_id: item.id,
        status: item.status,
      }));
      output.push(message('tool_result', item.status === 'completed' ? '文件变更已应用。' : `文件变更状态：${item.status ?? '未知'}`, {
        tool_name: 'apply_patch',
        tool_call_id: item.id,
        status: item.status,
      }));
    }
  }
  return output.filter(Boolean);
}

function contentText(parts) {
  return (Array.isArray(parts) ? parts : [])
    .filter((part) => part?.type === 'text')
    .map((part) => asText(part.text))
    .filter(Boolean)
    .join('\n');
}

function codeBuddyMessages(events) {
  const output = [];
  for (const event of events) {
    if (event?.type === 'assistant') {
      for (const part of event.message?.content ?? []) {
        // Deliberately omit private thinking blocks. Visible text and observable
        // tool activity carry the reusable engineering evidence.
        if (part?.type === 'text') {
          output.push(message('assistant', part.text, { timestamp: event.__timestamp }));
        } else if (part?.type === 'tool_use') {
          output.push(message('tool_call', asText(part.input), {
            tool_name: part.name || 'tool',
            tool_call_id: part.id,
            timestamp: event.__timestamp,
          }));
        }
      }
      continue;
    }
    if (event?.type === 'user') {
      for (const part of event.message?.content ?? []) {
        if (part?.type !== 'tool_result') continue;
        const text = typeof part.content === 'string' ? part.content : contentText(part.content);
        output.push(message('tool_result', text || (part.is_error ? '工具执行失败。' : '工具执行完成。'), {
          tool_name: part.tool_name,
          tool_call_id: part.tool_use_id,
          timestamp: event.__timestamp,
          status: part.is_error ? 'failed' : 'completed',
        }));
      }
      continue;
    }
    if (event?.type === 'result') {
      const resultText = event.result
        || (Array.isArray(event.errors) ? event.errors.join('\n') : '')
        || (Array.isArray(event.errors_info)
          ? event.errors_info.map((item) => item?.details || item?.code).filter(Boolean).join('\n')
          : '');
      const finalMessage = message('assistant', resultText, {
        timestamp: event.__timestamp,
        ...(event.is_error ? { status: 'failed' } : {}),
      });
      if (finalMessage) {
        if (output.at(-1)?.content !== finalMessage.content) {
          output.push(finalMessage);
        } else if (event.is_error) {
          output[output.length - 1] = { ...output.at(-1), status: 'failed' };
        }
      }
    }
  }
  return output.filter(Boolean);
}

function enforceTotalLimit(messages) {
  let used = 0;
  const output = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    const remaining = TOTAL_CONTENT_LIMIT - used;
    if (remaining <= 0) continue;
    const shortened = truncateMiddle(item.content, remaining);
    output.unshift({ ...item, ...shortened });
    used += shortened.content.length;
  }
  return output;
}

export function parseJsonLines(text) {
  return String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function normalizeAgentSession({ session, transcript, taskPrompt }) {
  const events = parseJsonLines(transcript);
  const isCodex = events.some((event) => event?.type === 'thread.started' || String(event?.type).startsWith('item.'));
  const sourceFormat = isCodex ? 'codex-jsonl' : 'codebuddy-jsonl';
  const activity = isCodex ? codexMessages(events) : codeBuddyMessages(events);
  const prompt = message('user', taskPrompt || '完成当前软件研发任务。');
  const messages = enforceTotalLimit([prompt, ...activity].filter(Boolean)).slice(-500);
  const tools = new Set(messages.filter((item) => item.tool_name).map((item) => item.tool_name));
  return {
    schema_version: 1,
    session_id: session.session_id,
    harness: session.harness || (isCodex ? 'Codex CLI' : 'CodeBuddy Code'),
    model: session.model,
    source_format: sourceFormat,
    started_at: session.started_at,
    finished_at: session.finished_at,
    outcome: session.outcome,
    turns: session.turns,
    event_count: events.length,
    message_count: messages.length,
    tools: Array.from(tools),
    messages,
  };
}
