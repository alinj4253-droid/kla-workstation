import { describe, expect, it } from 'vitest';
import { createConversationRequestSchema } from './projects.js';

describe('群组创建契约', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  it('支持明确角色池，并兼容未传角色池的原有调用', () => {
    expect(createConversationRequestSchema.parse({ projectId: 'project', name: ' 群组 ', agentIds: [id] })).toEqual({ projectId: 'project', name: '群组', agentIds: [id] });
    expect(createConversationRequestSchema.safeParse({ projectId: 'project', name: '群组' }).success).toBe(true);
  });
  it('拒绝空白名称、空角色池、重复和非法智能体 ID', () => {
    expect(createConversationRequestSchema.safeParse({ projectId: 'project', name: '  ', agentIds: [id] }).success).toBe(false);
    for (const agentIds of [[], [id, id], ['invalid-id'], Array(101).fill(id)]) {
      expect(createConversationRequestSchema.safeParse({ projectId: 'project', name: '群组', agentIds }).success).toBe(false);
    }
  });
});
