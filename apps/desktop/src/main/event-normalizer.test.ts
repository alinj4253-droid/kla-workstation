// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseLine, normalizeOutput, agentEventSchema } from './event-normalizer';

// Re-export for test access
const testSchema = agentEventSchema;

describe('parseLine', () => {
  const runId = 'test-run-001';

  it('parses a valid run.started JSON event', () => {
    const line = JSON.stringify({ type: 'run.started', runId, at: '2026-07-22T10:00:00.000Z' });
    const result = parseLine(line, runId);
    expect(result.type).toBe('run.started');
    if (result.type === 'run.started') {
      expect(result.runId).toBe(runId);
    }
  });

  it('parses a valid message.delta JSON event', () => {
    const line = JSON.stringify({ type: 'message.delta', text: '分析中...', at: '2026-07-22T10:00:01.000Z' });
    const result = parseLine(line, runId);
    expect(result.type).toBe('message.delta');
    if (result.type === 'message.delta') {
      expect(result.text).toBe('分析中...');
    }
  });

  it('parses a valid tool.requested JSON event', () => {
    const line = JSON.stringify({
      type: 'tool.requested',
      callId: 'call-001',
      tool: 'read_file',
      safeSummary: '读取 src/index.ts',
      at: '2026-07-22T10:00:02.000Z',
    });
    const result = parseLine(line, runId);
    expect(result.type).toBe('tool.requested');
    if (result.type === 'tool.requested') {
      expect(result.tool).toBe('read_file');
    }
  });

  it('parses a valid tool.completed JSON event', () => {
    const line = JSON.stringify({ type: 'tool.completed', callId: 'call-001', ok: true, at: '2026-07-22T10:00:03.000Z' });
    const result = parseLine(line, runId);
    expect(result.type).toBe('tool.completed');
    if (result.type === 'tool.completed') {
      expect(result.ok).toBe(true);
    }
  });

  it('parses a valid artifact.proposed JSON event', () => {
    const line = JSON.stringify({ type: 'artifact.proposed', sandboxRelativePath: 'output/report.md', at: '2026-07-22T10:00:04.000Z' });
    const result = parseLine(line, runId);
    expect(result.type).toBe('artifact.proposed');
  });

  it('parses a valid warning JSON event', () => {
    const line = JSON.stringify({ type: 'warning', code: 'SLOW_RESPONSE', message: '响应时间超过 10s', at: '2026-07-22T10:00:05.000Z' });
    const result = parseLine(line, runId);
    expect(result.type).toBe('warning');
  });

  it('parses a valid run.completed JSON event', () => {
    const line = JSON.stringify({ type: 'run.completed', at: '2026-07-22T10:00:06.000Z' });
    const result = parseLine(line, runId);
    expect(result.type).toBe('run.completed');
  });

  it('parses a valid run.failed JSON event', () => {
    const line = JSON.stringify({ type: 'run.failed', code: 'EXIT_CODE_1', message: '进程异常退出', at: '2026-07-22T10:00:07.000Z' });
    const result = parseLine(line, runId);
    expect(result.type).toBe('run.failed');
  });

  it('degrades plain text line to protocol_degraded message.delta', () => {
    const result = parseLine('Hello, this is a regular text output', runId);
    expect(result.type).toBe('message.delta');
    if (result.type === 'message.delta') {
      expect(result.text).toBe('Hello, this is a regular text output');
      expect((result as any).protocol_degraded).toBe(true);
    }
  });

  it('degrades invalid JSON that looks like an object', () => {
    const result = parseLine('{invalid json}', runId);
    expect(result.type).toBe('message.delta');
    if (result.type === 'message.delta') {
      expect((result as any).protocol_degraded).toBe(true);
    }
  });

  it('degrades JSON that does not match any AgentEvent variant', () => {
    const line = JSON.stringify({ type: 'unknown.event', data: 'test' });
    const result = parseLine(line, runId);
    expect(result.type).toBe('message.delta');
    if (result.type === 'message.delta') {
      expect((result as any).protocol_degraded).toBe(true);
    }
  });

  it('truncates text exceeding 256 KB', () => {
    const huge = 'x'.repeat(300 * 1024);
    const result = parseLine(huge, runId);
    expect(result.type).toBe('message.delta');
    if (result.type === 'message.delta') {
      expect(result.text.length).toBeLessThanOrEqual(256 * 1024);
      expect((result as any).protocol_degraded).toBe(true);
    }
  });

  it('rejects schema-violating JSON event with missing required fields', () => {
    const line = JSON.stringify({ type: 'run.started', at: '2026-07-22T10:00:00.000Z' }); // missing runId
    const result = parseLine(line, runId);
    expect(result.type).toBe('message.delta');
    if (result.type === 'message.delta') {
      expect((result as any).protocol_degraded).toBe(true);
    }
  });

  it('rejects event with wrong type field type', () => {
    const line = JSON.stringify({ type: 'run.started', runId, at: 'not-a-datetime' });
    const result = parseLine(line, runId);
    expect(result.type).toBe('message.delta');
    if (result.type === 'message.delta') {
      expect((result as any).protocol_degraded).toBe(true);
    }
  });
});

describe('normalizeOutput', () => {
  const runId = 'test-run-002';

  it('returns empty array for empty input', () => {
    expect(normalizeOutput('', runId)).toEqual([]);
  });

  it('normalizes a single JSON event line', () => {
    const output = JSON.stringify({ type: 'run.started', runId, at: '2026-07-22T10:00:00.000Z' });
    const events = normalizeOutput(output, runId);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('run.started');
  });

  it('normalizes multiple JSON event lines', () => {
    const output = [
      JSON.stringify({ type: 'run.started', runId, at: '2026-07-22T10:00:00.000Z' }),
      JSON.stringify({ type: 'message.delta', text: '开始分析', at: '2026-07-22T10:00:01.000Z' }),
      JSON.stringify({ type: 'run.completed', at: '2026-07-22T10:00:02.000Z' }),
    ].join('\n');
    const events = normalizeOutput(output, runId);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.type)).toEqual(['run.started', 'message.delta', 'run.completed']);
  });

  it('merges consecutive plain text lines into one delta', () => {
    const output = '第一行文本\n第二行文本\n第三行文本';
    const events = normalizeOutput(output, runId);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('message.delta');
    if (events[0]!.type === 'message.delta') {
      expect(events[0]!.text).toBe('第一行文本\n第二行文本\n第三行文本');
    }
  });

  it('segregates structured events interleaved with plain text', () => {
    const output = [
      '一些普通文本',
      JSON.stringify({ type: 'tool.requested', callId: 'c1', tool: 'read_file', safeSummary: 'read', at: '2026-07-22T10:00:00.000Z' }),
      '更多文本',
    ].join('\n');
    const events = normalizeOutput(output, runId);
    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe('message.delta');
    expect(events[1]!.type).toBe('tool.requested');
    expect(events[2]!.type).toBe('message.delta');
  });

  it('skips blank lines', () => {
    const output = 'line1\n\n\nline2';
    const events = normalizeOutput(output, runId);
    expect(events).toHaveLength(1);
    if (events[0]!.type === 'message.delta') {
      expect(events[0]!.text).toBe('line1\nline2');
    }
  });

  it('handles mixed JSON and non-JSON output from real CLI', () => {
    const output = [
      '分析文件结构...',
      JSON.stringify({ type: 'tool.requested', callId: 'c1', tool: 'list_files', safeSummary: '列出项目文件', at: '2026-07-22T10:00:00.000Z' }),
      JSON.stringify({ type: 'tool.completed', callId: 'c1', ok: true, at: '2026-07-22T10:00:01.000Z' }),
      '发现 3 个关键文件',
      JSON.stringify({ type: 'run.completed', at: '2026-07-22T10:00:02.000Z' }),
    ].join('\n');
    const events = normalizeOutput(output, runId);
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events[0]!.type).toBe('message.delta');
    expect(events[1]!.type).toBe('tool.requested');
    expect(events[2]!.type).toBe('tool.completed');
    expect(events[events.length - 1]!.type).toBe('run.completed');
  });

  it('preserves structured text delta events when mixed with structured events', () => {
    const output = [
      JSON.stringify({ type: 'message.delta', text: '步骤 1: 分析中', at: '2026-07-22T10:00:00.000Z' }),
      JSON.stringify({ type: 'tool.requested', callId: 'c1', tool: 'search', safeSummary: '搜索', at: '2026-07-22T10:00:01.000Z' }),
      JSON.stringify({ type: 'message.delta', text: '步骤 2: 生成报告', at: '2026-07-22T10:00:02.000Z' }),
    ].join('\n');
    const events = normalizeOutput(output, runId);
    // 三个都是结构化事件（因为 JSON 解析成功），应各自独立
    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe('message.delta');
    expect(events[1]!.type).toBe('tool.requested');
    expect(events[2]!.type).toBe('message.delta');
    // 结构化 message.delta 不应有 protocol_degraded
    if (events[0]!.type === 'message.delta') {
      expect((events[0]! as any).protocol_degraded).toBeUndefined();
    }
  });
});

describe('AgentEvent schema validation', () => {
  it('rejects a message.delta exceeding 256KB text', () => {
    const result = testSchema.safeParse({
      type: 'message.delta' as const,
      text: 'x'.repeat(300 * 1024),
      at: '2026-07-22T10:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a tool.requested with safeSummary > 1024 chars', () => {
    const result = testSchema.safeParse({
      type: 'tool.requested' as const,
      callId: 'c1',
      tool: 'read',
      safeSummary: 'x'.repeat(2000),
      at: '2026-07-22T10:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects run.failed with message > 4096 chars', () => {
    const result = testSchema.safeParse({
      type: 'run.failed' as const,
      code: 'ERR',
      message: 'x'.repeat(5000),
      at: '2026-07-22T10:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});