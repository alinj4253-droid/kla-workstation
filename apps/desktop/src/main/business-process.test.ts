import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  POST_TASK_KNOWLEDGE_PREFIX,
  parseBusinessProcessResponse,
  parsePostTaskKnowledgeInstruction,
  runPostTaskKnowledgeCapture,
} from './business-process';
import type { ModelGateway } from './model-gateway';

describe('business process knowledge contract', () => {
  it('parses a dynamic business process with inputs, outputs, and ownership', () => {
    const parsed = parseBusinessProcessResponse(JSON.stringify({
      knowledgeDocument: {
        title: '经营分析经验归集',
        summary: '归集经营分析方法。',
        reusableInsights: ['先定义口径再计算'],
      },
      businessProcess: {
        applicable: true,
        title: '经营分析报告流程',
        summary: '形成可核验的经营判断。',
        stages: [{
          id: 'dimension-analysis',
          title: '分维度分析',
          objective: '覆盖收入与成本维度',
          owner: '经营分析人员',
          steps: [{
            id: 'acquire-revenue',
            title: '获取收入数据',
            actionType: 'acquire',
            inputs: ['财务明细'],
            outputs: ['收入数据集'],
            owner: '数据分析人员',
          }],
        }],
      },
    }), '获取某公司的经营分析报告');

    expect(parsed.process.applicable).toBe(true);
    expect(parsed.process.stages[0]?.title).toBe('分维度分析');
    expect(parsed.process.stages[0]?.steps[0]).toMatchObject({
      actionType: 'acquire',
      inputs: ['财务明细'],
      outputs: ['收入数据集'],
    });
  });

  it('keeps non-process work explicitly inapplicable instead of inventing stages', () => {
    const parsed = parseBusinessProcessResponse(JSON.stringify({
      knowledgeDocument: { title: '简单问答归集', summary: '一次性说明。' },
      businessProcess: {
        applicable: false,
        reason: '这是一次性概念解释，没有稳定的业务动作链。',
        title: '概念解释',
        stages: [{ title: '不应保留', steps: [{ title: '不应保留', actionType: 'other' }] }],
      },
    }), '解释一个概念');

    expect(parsed.process.applicable).toBe(false);
    expect(parsed.process.stages).toEqual([]);
    expect(parsed.process.reason).toContain('一次性概念解释');
  });

  it('reads the hidden post-task payload even when routing prepends an @mention', () => {
    const raw = `@知识管理智能体 ${POST_TASK_KNOWLEDGE_PREFIX}\n${JSON.stringify({
      originalTask: '生成经营分析报告',
      teamResults: '报告已完成',
      deliverables: ['outputs/report.html'],
    })}`;

    expect(parsePostTaskKnowledgeInstruction(raw)).toEqual({
      originalTask: '生成经营分析报告',
      teamResults: '报告已完成',
      deliverables: ['outputs/report.html'],
    });
  });

  it('writes the generated knowledge document inside the local project knowledge folder', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'kunqing-business-process-'));
    const gateway = {
      generateText: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          knowledgeDocument: { title: '经营分析知识', summary: '沉淀分析口径。' },
          businessProcess: {
            applicable: true,
            title: '经营分析流程',
            stages: [{
              title: '数据分析',
              steps: [{ title: '核验经营数据', actionType: 'validate', outputs: ['已核验数据'] }],
            }],
          },
        }),
      }),
    } as unknown as ModelGateway;

    try {
      const result = await runPostTaskKnowledgeCapture({
        gateway,
        payload: { originalTask: '生成经营分析报告', teamResults: '报告已经完成。', deliverables: ['outputs/report.html'] },
        projectRoot,
        runId: 'run-1',
        agentInstanceId: 'knowledge-1',
        agentName: '知识管理智能体',
      });

      expect(result.knowledgeDocumentPath).toMatch(/^knowledge\/experience\/.+\.md$/);
      expect(await readFile(join(projectRoot, ...result.knowledgeDocumentPath.split('/')), 'utf8')).toContain('# 经营分析知识');
      expect(result.businessProcess.generatedByAgentName).toBe('知识管理智能体');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
