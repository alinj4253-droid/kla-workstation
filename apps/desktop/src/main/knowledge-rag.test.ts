import { describe, expect, it, vi } from 'vitest';
import type { HybridKnowledgeResult } from './hybrid-knowledge-search';
import { buildRagEvidenceContext, fallbackRagAnswer, selectRagEvidence, synthesizeKnowledgeAnswer } from './knowledge-rag';

const result: HybridKnowledgeResult = {
  query: '请假两天由谁审批',
  strategy: ['keyword', 'vector'],
  hits: [
    { id: '1', kind: 'chunk', title: '考勤制度', excerpt: '员工请假两天，应先由直属负责人审核，再提交部门负责人审批。', score: 1, channels: ['keyword'], sourceFile: '考勤管理制度.pdf', location: '第 3 页' },
    { id: '2', kind: 'wiki', title: '请假流程', excerpt: '员工请假两天，应先由直属负责人审核，再提交部门负责人审批。', score: 0.9, channels: ['wiki'] },
    { id: '3', kind: 'chunk', title: '申请要求', excerpt: '除紧急情况外，请假申请应提前在系统中提交。', score: 0.8, channels: ['vector'], sourceFile: '员工手册.pdf' },
  ],
};

describe('knowledge RAG synthesis', () => {
  it('deduplicates evidence and builds bounded cited context', () => {
    const hits = selectRagEvidence(result);
    expect(hits).toHaveLength(2);
    expect(buildRagEvidenceContext(hits)).toContain('[1] 来源：考勤管理制度.pdf，位置：第 3 页');
  });

  it('uses reasoning when the fast slot is not configured', async () => {
    const generateText = vi.fn()
      .mockRejectedValueOnce(new Error('模型未配置：请为「快速」绑定模型'))
      .mockResolvedValueOnce({ text: '请假两天需要直属负责人审核并由部门负责人审批 [1]；通常应提前提交申请 [2]。' });
    const answer = await synthesizeKnowledgeAnswer({ gateway: { generateText } as never, query: result.query, result });
    expect(answer.modelSlot).toBe('reasoning');
    expect(answer.answer).toContain('[1]');
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('falls back to concise conclusions instead of raw result metadata', async () => {
    const generateText = vi.fn().mockRejectedValue(new Error('offline'));
    const answer = await synthesizeKnowledgeAnswer({ gateway: { generateText } as never, query: result.query, result });
    expect(answer.answer).toContain('根据当前知识库');
    expect(answer.answer).not.toContain('相关度');
    expect(answer.answer.length).toBeLessThan(1_200);
    expect(fallbackRagAnswer('未知问题', [])).toContain('没有找到');
  });
});
