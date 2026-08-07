import { describe, expect, it } from 'vitest';
import {
  buildSafeSynthesisFallback,
  containsInternalOrchestrationProtocol,
  isSimpleDirectTask,
  removeUnverifiedAgentFailureClaims,
  runOrchestrator,
} from '../src/orchestrator';
import type { IGraphContext } from '../src/types';

describe('orchestrator final response safety', () => {
  it('keeps short weather and time questions out of team delegation', () => {
    expect(isSimpleDirectTask('帮我查询一下今天上海天气')).toBe(true);
    expect(isSimpleDirectTask('现在几点？')).toBe(true);
    expect(isSimpleDirectTask('整理近三年天气数据并生成分析报告')).toBe(false);
  });

  it('detects internal routing protocols before they enter formal chat messages', () => {
    expect(containsInternalOrchestrationProtocol('NEED_AGENTS codebuddy: 请继续发布成果')).toBe(true);
    expect(containsInternalOrchestrationProtocol('处理完成，成果已经发布。')).toBe(false);
  });

  it('uses the completed member result instead of exposing a mechanical delegation prompt', () => {
    const fallback = buildSafeSynthesisFallback(
      '--- codebuddy 结果 ---\n页面已经完成，文件位于 outputs/report.html。',
      '请制作一份 HTML 报告',
    );
    expect(fallback).toBe('页面已经完成，文件位于 outputs/report.html。');
    expect(fallback).not.toContain('NEED_AGENTS');
  });

  it('removes leaked protocol lines from a fallback result', () => {
    const fallback = buildSafeSynthesisFallback(
      'NEED_AGENTS worker: 请重新处理\n\n现有成果位于 outputs/report.html。',
      '请制作一份 HTML 报告',
    );
    expect(fallback).toBe('现有成果位于 outputs/report.html。');
  });

  it('removes failure claims about agents that were not actually delegated', () => {
    const result = removeUnverifiedAgentFailureClaims(
      '资料调研已经完成。CodeBuddy 没有完成任务。最终报告已生成。',
      ['资料调研智能体'],
      ['资料调研智能体', 'CodeBuddy', '知识管理智能体'],
    );

    expect(result).toBe('资料调研已经完成。最终报告已生成。');
    expect(result).not.toContain('CodeBuddy');
  });

  it('respects the model-selected member and performs one post-task knowledge capture', async () => {
    const delegated: Array<{ target: string; instruction: string }> = [];
    let generation = 0;
    const ctx: IGraphContext = {
      projectId: 'project-1',
      agentInstanceId: 'orchestrator-1',
      runId: 'root-run',
      instruction: '分析某品牌的市场机会并生成一份完整 HTML 方案报告',
      triggerMessageId: 'user-message-1',
      signal: new AbortController().signal,
      workspaceRoot: 'C:/tmp/project-1',
      services: {
        async generateText() {
          generation += 1;
          return generation === 1
            ? { text: 'NEED_AGENTS\ncodebuddy-1: 请完成整项任务' }
            : { text: '报告已经完成。' };
        },
        getToolDefinitions: () => [],
        async executeTool() { return ''; },
        async createFileRecord() {},
        async insertMessage() { return 'result-message'; },
        async sendDelegationMessage(input) {
          delegated.push({ target: input.targetAgentInstanceId, instruction: input.instruction });
          return { messageId: `message-${input.targetAgentInstanceId}`, childRunIds: [`run-${input.targetAgentInstanceId}`] };
        },
        setRunStatus() {},
        setResultMessage() {},
        addRunEvent() {},
        getRunStatus(runId) { return { status: 'completed', resultMessageId: `${runId}-result` }; },
        getParentRunId: () => null,
        getRunAgentInstanceId: () => null,
        getAgentDisplayName: () => null,
        createSubRun: () => '',
        enqueueRun() {},
        emitEvent() {},
        storeMemory() {},
        consolidateMemory: () => 0,
        extractLongTermMemory: () => 0,
        buildMemoryContext: () => '',
        async buildContextSnapshot() { return { snapshotChecksum: 'snapshot', messages: [] }; },
        async writeContextManifest() {},
        getProjectRoot: () => 'C:/tmp/project-1',
        renderSnapshotToText: () => '',
        getKmInstance: () => ({ id: 'knowledge-1', identityRelPath: null, profileEnabled: 1 }),
        getProjectDelegatableAgents: () => [
          { id: 'knowledge-1', name: '知识管理智能体', role: 'teammate', definitionId: 'builtin.knowledge-manager', runtimeMode: 'native-model' },
          { id: 'research-1', name: '资料调研智能体', role: 'teammate', definitionId: 'builtin.researcher', runtimeMode: 'native-model' },
          { id: 'codebuddy-1', name: 'CodeBuddy', role: 'teammate', definitionId: 'custom.codebuddy', runtimeMode: 'external-cli' },
        ],
        getMessageContent: (messageId) => `已完成：${messageId}`,
        getLogger: () => ({ info() {}, warn() {}, error() {} }),
      },
    };

    await runOrchestrator(ctx);

    expect(delegated.map((item) => item.target)).toEqual(['codebuddy-1', 'knowledge-1']);
    expect(delegated[0]?.instruction).toBe('请完成整项任务');
    expect(delegated[1]?.instruction).toContain('KQ_POST_TASK_KNOWLEDGE_V1');
    expect(delegated.filter((item) => item.target === 'knowledge-1')).toHaveLength(1);
  });
});
