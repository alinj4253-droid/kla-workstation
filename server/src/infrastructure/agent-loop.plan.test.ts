import { taskPlanSchema } from '@kla-workstation/contracts';
import { describe, expect, it } from 'vitest';
import { GatewayError } from '../compute/gateway.js';
import { compactTranscriptForModel, modelRetryDecision, normalizeTaskPlanPayload } from './agent-loop.js';

describe('compactTranscriptForModel', () => {
  it('omits only confirmed long artifact contents from model input while keeping the checkpoint intact', () => {
    const longContent = '报告正文'.repeat(3_000);
    const call = { id: 'saved-1', type: 'function', function: { name: 'artifact_write', arguments: JSON.stringify({ fileName: 'report.md', content: longContent, mimeType: 'text/markdown' }) } };
    const failed = { id: 'failed-1', type: 'function', function: { name: 'artifact_write', arguments: JSON.stringify({ fileName: 'retry.md', content: longContent, mimeType: 'text/markdown' }) } };
    const messages = [
      { role: 'system', content: '保留当前任务约束' },
      { role: 'assistant', tool_calls: [call, failed] },
      { role: 'tool', tool_call_id: 'saved-1', content: JSON.stringify({ stored: true, artifactId: 'artifact-1', checksum: 'abc' }) },
      { role: 'tool', tool_call_id: 'failed-1', content: JSON.stringify({ error: '写入失败' }) },
    ];
    const compacted = compactTranscriptForModel(messages);
    expect(compacted[1].tool_calls[0].function.arguments).not.toContain(longContent);
    expect(JSON.parse(compacted[1].tool_calls[0].function.arguments)).toMatchObject({ fileName: 'report.md', mimeType: 'text/markdown' });
    expect(compacted[1].tool_calls[1]).toEqual(failed);
    expect(compacted[2]).toEqual(messages[2]);
    expect(compacted[0]).toEqual(messages[0]);
    expect(call.function.arguments).toContain(longContent);
  });
});

describe('normalizeTaskPlanPayload', () => {
  it('accepts a four-step model plan when only the fourth title is missing', () => {
    const agentId = 'd7f241a5-5881-48b1-8f1b-02721b22f49d';
    const result = taskPlanSchema.parse(normalizeTaskPlanPayload({
      tasks: [
        { title: '大纲', instruction: '编写大纲', agentId, dependsOn: [] },
        { title: '第一章', instruction: '编写第一章', agentId, dependsOn: [1] },
        { title: '第二章', instruction: '编写第二章', agentId, dependsOn: [2] },
        { instruction: '整理第四章内容。完成后检查链接', agentId, dependsOn: [3] },
      ],
    }));

    expect(result.tasks.map(task => task.title)).toEqual(['大纲', '第一章', '第二章', '整理第四章内容']);
    expect(result.tasks[3].dependsOn).toEqual([3]);
  });

  it('still rejects a task without executable instructions', () => {
    const agentId = 'd7f241a5-5881-48b1-8f1b-02721b22f49d';
    expect(() => taskPlanSchema.parse(normalizeTaskPlanPayload({ tasks: [{ agentId, dependsOn: [] }] }))).toThrow();
  });
});

describe('modelRetryDecision', () => {
  it('retries upstream timeouts and 5xx with growing backoff', () => {
    const timeout = new GatewayError('UNAVAILABLE', 'Sub2API 请求超时', 504);
    expect(modelRetryDecision(timeout, 1)).toEqual({ retry: true, delayMs: 1000 });
    expect(modelRetryDecision(timeout, 2)).toEqual({ retry: true, delayMs: 3000 });
  });

  it('does not retry permanent model errors, exhausted attempts, or cancellation', () => {
    expect(modelRetryDecision(new GatewayError('NOT_FOUND', '模型已停用', 404), 1).retry).toBe(false);
    expect(modelRetryDecision(new GatewayError('FORBIDDEN', '缺少 model.use 权限', 403), 1).retry).toBe(false);
    expect(modelRetryDecision(new GatewayError('UNAVAILABLE', 'Sub2API 请求超时', 504), 3).retry).toBe(false);
    expect(modelRetryDecision(new GatewayError('UNAVAILABLE', 'Sub2API 请求超时', 504), 1, 3, true).retry).toBe(false);
    expect(modelRetryDecision(new Error('boom'), 1).retry).toBe(false);
  });
});
