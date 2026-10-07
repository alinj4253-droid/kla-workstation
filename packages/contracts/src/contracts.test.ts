import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { pageQuerySchema, apiOkEnvelopeSchema } from './envelope.js';
import type { ApiOkEnvelope } from './envelope.js';
import { apiError, isRetryable } from './errors.js';
import { SSE_EVENTS, sseEnvelopeSchema } from './events.js';
import { registerRequestSchema } from './auth.js';
import { agentRowSchema, conversationAgentRowSchema } from './agents.js';
import { artifactSchema } from './artifacts.js';
import { bootstrapModelSchema, bootstrapResponseSchema, taskSummarySchema } from './bootstrap.js';
import { fileItemSchema, uploadSessionRowSchema } from './files.js';
import { postgresHealthResponseSchema, postgresHealthSchema, redisHealthResponseSchema, redisHealthSchema, serviceHealthSchema } from './health.js';
import { knowledgeSearchResultSchema, readKnowledgeDocumentResponseSchema } from './knowledge.js';
import { memoryRowSchema, memorySearchHitSchema, memoryViewSchema } from './memories.js';
import { meetingDetailSchema, meetingSchema } from './meetings.js';
import { modelCatalogItemSchema, modelTestResultSchema } from './models.js';
import { cancelledRunRowSchema, conversationRunSchema, replaceRunStepsRequestSchema, runStepRowSchema } from './runs.js';
import { operationPlatformSchema, operationSkillSchema, executeOperationResponseSchema } from './operations.js';
import { permissionRowSchema, skillRowSchema } from './skills.js';
import { workspaceRowSchema } from './workspaces.js';

describe('errors', () => {
  it('maps retryable by code', () => {
    expect(isRetryable('RATE_LIMITED')).toBe(true);
    expect(isRetryable('UNAVAILABLE')).toBe(true);
    expect(isRetryable('FORBIDDEN')).toBe(false);
    expect(isRetryable('NOT_IMPLEMENTED')).toBe(false);
  });

  it('builds the spec error envelope', () => {
    expect(apiError('NOT_IMPLEMENTED', '未实现', { requestId: 'req-1' })).toEqual({
      ok: false,
      error: { code: 'NOT_IMPLEMENTED', message: '未实现', retryable: false },
      meta: { requestId: 'req-1' },
    });
  });

  it('omits meta when no requestId', () => {
    expect(apiError('FORBIDDEN', '无权访问').meta).toBeUndefined();
  });
});

describe('envelope', () => {
  it('applies pagination defaults', () => {
    expect(pageQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(pageQuerySchema.parse({ page: '3', pageSize: '50' })).toEqual({ page: 3, pageSize: 50 });
  });

  it('keeps ApiOkEnvelope inferred from apiOkEnvelopeSchema', () => {
    const sampleSchema = z.object({ id: z.string() });
    type SampleEnvelope = z.infer<
      ReturnType<typeof apiOkEnvelopeSchema<typeof sampleSchema>>
    >;
    expectTypeOf<ApiOkEnvelope<{ id: string }>>().toEqualTypeOf<SampleEnvelope>();
  });
});

describe('auth', () => {
  it('requires email or phone on register', () => {
    expect(
      registerRequestSchema.safeParse({ password: 'secret123', nickname: 'n' }).success,
    ).toBe(false);
    expect(
      registerRequestSchema.safeParse({ email: 'a@b.co', password: 'secret123', nickname: 'n' })
        .success,
    ).toBe(true);
  });
});

describe('events', () => {
  it('validates the sse envelope', () => {
    const parsed = sseEnvelopeSchema.safeParse({
      eventId: 'evt-1',
      sequence: 1,
      identityId: 'id-1',
      scope: { type: 'conversation', id: 'c-1' },
      createdAt: new Date().toISOString(),
      name: SSE_EVENTS[0],
      payload: {},
    });
    expect(parsed.success).toBe(true);
  });
});

describe('implemented rest surface', () => {
  const iso = '2026-01-01T00:00:00.000Z';

  const samples: Array<[string, z.ZodTypeAny, unknown]> = [
    ['serviceHealth', serviceHealthSchema, { ok: true, service: 'kla-backend', version: '0.1.0', mode: 'mock' }],
    ['postgresHealth', postgresHealthSchema, { configured: true, connected: true, database: 'kla', serverVersion: 'pg16', latencyMs: 3 }],
    ['redisHealth', redisHealthSchema, { configured: true, connected: true, database: 4, latencyMs: 1 }],
    ['postgresHealthResponse.ok', postgresHealthResponseSchema, { ok: true, data: { configured: true, connected: true, database: 'kla', latencyMs: 3 } }],
    ['postgresHealthResponse.degraded', postgresHealthResponseSchema, { ok: false, data: { configured: true, connected: false, error: 'timeout' } }],
    ['postgresHealthResponse.notConfigured', postgresHealthResponseSchema, { ok: false, error: { code: 'DATABASE_NOT_CONFIGURED', message: '未配置', retryable: false } }],
    ['redisHealthResponse.degraded', redisHealthResponseSchema, { ok: false, data: { configured: false, connected: false, error: 'REDIS_URL 未配置' } }],
    ['workspaceRow', workspaceRowSchema, { id: 'w-1', type: 'personal', name: '工作区', project_id: null }],
    ['agentRow', agentRowSchema, { id: 'a-1', name: '统筹智能体', role: '调度', type: 'official', model_id: null, enabled: true, version: 1 }],
    ['conversationAgentRow', conversationAgentRowSchema, { id: 'a-1', name: '统筹智能体', role: '调度', type: 'official', model_id: null, enabled: true, conversation_role: 'member' }],
    ['modelCatalogItem', modelCatalogItemSchema, { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'deepseek', base_url: 'https://api.example.com/v1', capabilities: { thinking: false }, enabled: true, is_official: true, configured: false }],
    ['modelTestResult', modelTestResultSchema, { success: true, latencyMs: 120, reply: '连接成功' }],
    ['conversationRun', conversationRunSchema, { id: 'r-1', conversationId: 'c-1', triggerMessageId: 'm-1', status: 'completed', mode: 'balanced', currentAgent: '统筹智能体', result: {}, createdAt: iso, updatedAt: iso }],
    ['cancelledRunRow', cancelledRunRowSchema, { id: 'r-1', conversation_id: 'c-1', trigger_message_id: 'm-1', status: 'failed', mode: 'balanced', current_agent: null, result: { cancelled: true }, created_at: iso, updated_at: iso }],
    ['runStepRow', runStepRowSchema, { id: 's-1', run_id: 'r-1', step_index: 1, title: '检索', instruction: '', assigned_agent_id: null, status: 'pending', result: null, created_at: iso, updated_at: iso }],
    ['replaceRunSteps', replaceRunStepsRequestSchema, { steps: [{ title: '检索资料', assignedAgentId: 'a-1' }] }],
    ['artifact', artifactSchema, { id: 'art-1', conversationId: 'c-1', name: '周报.html', mimeType: 'text/html', content: '<p>hi</p>', sizeBytes: 10, createdAt: iso }],
    ['memoryView', memoryViewSchema, { id: 'mem-1', workspaceId: 'w-1', content: '偏好', kind: 'long_term', metadata: {}, createdAt: iso, updatedAt: iso }],
    ['memoryRow', memoryRowSchema, { id: 'mem-1', workspace_id: 'w-1', content: '偏好', kind: 'long_term', metadata: {}, created_at: iso }],
    ['memorySearchHit', memorySearchHitSchema, { id: 'mem-1', workspace_id: 'w-1', content: '偏好', kind: 'long_term', metadata: null, created_at: iso, score: 0.42 }],
    ['fileItem', fileItemSchema, { id: 'f-1', workspaceId: 'w-1', name: 'a.pdf', storageKey: 'k', checksum: null, contentType: 'application/pdf', sizeBytes: 8, status: 'ready', createdAt: iso }],
    ['uploadSessionRow', uploadSessionRowSchema, { id: 'u-1', file_name: 'a.pdf', content_type: null, size_bytes: 8, checksum: null, status: 'open', expires_at: iso, uploadUrl: null, mode: 'server-multipart-placeholder' }],
    ['knowledgeSearchResult', knowledgeSearchResultSchema, { hits: [] }],
    ['readKnowledgeDocument', readKnowledgeDocumentResponseSchema, { content: '片段', startOffset: 0, endOffset: 2, hasMore: false }],
    ['operationPlatform', operationPlatformSchema, { id: 'p-1', identity_id: 'i-1', name: '平台', base_url: '', description: null, status: 'active', metadata: {}, created_at: iso, updated_at: iso }],
    ['operationSkill', operationSkillSchema, { id: 'sk-1', platform_id: 'p-1', name: '技能', description: null, definition: null, created_at: iso }],
    ['executeOperation', executeOperationResponseSchema, { taskId: 't-1', platformId: 'p-1', status: 'queued', executionMode: 'visual_dom', message: '已入队' }],
    ['meeting', meetingSchema, { id: 'mt-1', identity_id: 'i-1', project_id: null, name: '周会', description: null, input_type: 'audio_upload', status: 'waiting_upload', created_at: iso, updated_at: iso }],
    ['meetingDetail', meetingDetailSchema, { id: 'mt-1', identity_id: 'i-1', project_id: null, name: '周会', description: null, input_type: 'audio_upload', status: 'transcribing', created_at: iso, updated_at: iso, segments: [{ id: 'seg-1', meeting_id: 'mt-1', speaker: 'A', content: '开始', start_ms: 0, end_ms: 1000, confidence: 0.9, created_at: iso }] }],
    ['skillRow', skillRowSchema, { id: 'sk-1', agent_id: 'a-1', name: '检索', description: null, definition: null, enabled: true, version: 1, agent_name: '统筹智能体' }],
    ['permissionRow', permissionRowSchema, { code: 'workspace.read', description: null }],
    [
      'bootstrap',
      bootstrapResponseSchema,
      {
        user: { id: 'u-1', email: 'a@b.co', phone: null, nickname: 'n', status: 'active' },
        identity: { id: 'i-1', userId: 'u-1', type: 'personal', displayName: 'n', organizationId: null, status: 'active', isDefault: true },
        identities: [],
        projects: [{ id: 'p-1', name: '项目', ownerIdentityId: 'i-1', createdAt: iso }],
        conversations: [{ id: 'c-1', projectId: 'p-1', name: '群聊', createdAt: iso }],
        workspaces: [{ id: 'w-1', type: 'personal', name: '工作区', project_id: null }],
        agents: [{ id: 'a-1', name: '统筹智能体', role: '调度', type: 'official', model_id: null, enabled: true, version: 1 }],
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'deepseek', capabilities: {}, enabled: true }],
        tasks: [{ id: 't-1', title: '任务', status: 'pending', result: null, created_at: iso }],
      },
    ],
  ];

  it.each(samples)('%s schema 接受线上一致样例', (_name, schema, sample) => {
    const parsed = schema.safeParse(sample);
    expect(parsed.error).toBeUndefined();
    expect(parsed.success).toBe(true);
  });

  it('model test result 拒绝非布尔 success', () => {
    expect(modelTestResultSchema.safeParse({ success: 'yes' }).success).toBe(false);
  });
});
