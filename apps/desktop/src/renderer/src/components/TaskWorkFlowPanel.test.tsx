import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TaskWorkFlowPanel } from './TaskWorkFlowPanel';
import type { RunActivity } from './VirtualMessageList';

describe('TaskWorkFlowPanel', () => {
  it('renders the knowledge-manager business process instead of run traces', () => {
    const run: RunActivity = {
      runId: 'knowledge-run-1',
      status: 'completed',
      agentId: 'knowledge-agent-1',
      agentName: '知识管理智能体',
      triggerMessageId: 'message-1',
      updatedAt: '2026-08-04T10:10:00.000Z',
      traces: [{
        id: 'trace-1',
        kind: 'reasoning',
        title: '这条运行轨迹不应出现在流程视图',
        status: 'completed',
        at: '2026-08-04T10:00:00.000Z',
      }],
      businessProcess: {
        schemaVersion: 1,
        applicable: true,
        title: '企业经营分析流程',
        summary: '从业务维度形成可核验结论。',
        generatedByAgentId: 'knowledge-agent-1',
        generatedByAgentName: '知识管理智能体',
        generatedAt: '2026-08-04T10:10:00.000Z',
        knowledgeDocumentPath: 'knowledge/experience/report.md',
        stages: [{
          id: 'stage-1',
          title: '收入维度分析',
          objective: '确认收入增长质量',
          steps: [{
            id: 'step-1',
            title: '获取收入明细',
            actionType: 'acquire',
            inputs: ['财务明细'],
            outputs: ['收入数据集'],
          }],
        }],
      },
    };

    render(<TaskWorkFlowPanel
      runs={[run]}
      messages={[{ id: 'message-1', contentJson: JSON.stringify({ text: '生成经营分析报告' }), createdAt: '2026-08-04T09:00:00.000Z' }]}
    />);

    expect(screen.getByText('企业经营分析流程')).toBeInTheDocument();
    expect(screen.getByText('收入维度分析')).toBeInTheDocument();
    expect(screen.getByText('获取收入明细')).toBeInTheDocument();
    expect(screen.queryByText('这条运行轨迹不应出现在流程视图')).not.toBeInTheDocument();
  });
});
