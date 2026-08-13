import { describe, expect, it } from 'vitest';
import {
  applyDeliverableDefaults,
  buildResearchFallbackTask,
  buildSafeSynthesisFallback,
  buildKnowledgeManagerTask,
  containsInternalOrchestrationProtocol,
  isConversationStatusQuestion,
  isNearDuplicateMemberSummary,
  isKnowledgeEvidenceMissing,
  isSimpleDirectTask,
  needsConversationTaskResolution,
  removeUnverifiedAgentFailureClaims,
  removeHtmlSourceFromFormalMessage,
  parseAcceptanceDecision,
  requiresArtifactDeliverable,
  requiresHtmlDeliverable,
  requiresMaterialReviewWorkflow,
  requiresQualityReview,
  resolveConversationTask,
  runOrchestrator,
  shouldCurateKnowledge,
} from '../src/orchestrator';
import type { IGraphContext } from '../src/types';

describe('orchestrator final response safety', () => {
  it('only starts the first step when a planner omits an explicit parallel group', async () => {
    const delegated: string[] = [];
    let generation = 0;
    const ctx: IGraphContext = {
      projectId: 'project-serial-plan', agentInstanceId: 'orchestrator-1', runId: 'root-serial-plan',
      instruction: '先查资料，再根据资料写报告', triggerMessageId: 'message-serial-plan',
      signal: new AbortController().signal, workspaceRoot: 'C:/tmp/project-serial-plan',
      services: {
        async generateText() {
          generation += 1;
          if (generation === 1) return { text: JSON.stringify({
            status: 'delegate', reason: '先取得输入再生成材料', assignments: [
              { stepId: 'research', agentInstanceId: 'researcher-1', objective: '检索与主题相关的资料' },
              { stepId: 'write', agentInstanceId: 'writer-1', objective: '根据检索结果写报告', dependsOn: ['research'] },
            ],
          }) };
          return { text: '资料已取得，报告也已完成。' };
        },
        getToolDefinitions: () => [], async executeTool() { return ''; }, async createFileRecord() {},
        async insertMessage() { return 'result'; },
        async sendDelegationMessage(input) {
          delegated.push(input.targetAgentInstanceId);
          return { messageId: `message-${input.targetAgentInstanceId}`, childRunIds: [`run-${input.targetAgentInstanceId}`] };
        },
        setRunStatus() {}, setResultMessage() {}, addRunEvent() {},
        getRunStatus: () => ({ status: 'completed', resultMessageId: 'child-result' }),
        getParentRunId: () => null, getRunAgentInstanceId: () => null, getAgentDisplayName: () => null,
        createSubRun: () => '', enqueueRun() {}, emitEvent() {}, storeMemory() {}, consolidateMemory: () => 0,
        extractLongTermMemory: () => 0, buildMemoryContext: () => '',
        async buildContextSnapshot() { return { snapshotChecksum: 'serial-plan', messages: [] }; },
        async writeContextManifest() {}, getProjectRoot: () => 'C:/tmp/project-serial-plan', renderSnapshotToText: () => '',
        getKmInstance: () => undefined,
        getProjectDelegatableAgents: () => [
          { id: 'researcher-1', name: '资料调研智能体', role: 'teammate', definitionId: 'builtin.researcher', runtimeMode: 'native-model' },
          { id: 'writer-1', name: '材料编写智能体', role: 'teammate', definitionId: 'builtin.material-writer', runtimeMode: 'native-model' },
        ],
        getMessageContent: () => '资料已取得。', getLogger: () => ({ info() {}, warn() {}, error() {} }),
      },
    };

    await runOrchestrator(ctx);
    expect(delegated[0]).toBe('researcher-1');
    expect(delegated.slice(0, 2)).toEqual(['researcher-1', 'writer-1']);
  });

  it('waits for every nested handoff before a parent result becomes available', async () => {
    const delegated: string[] = [];
    let nestedStatus = 'running';
    const ctx: IGraphContext = {
      projectId: 'project-nested-handoff', agentInstanceId: 'orchestrator-1', runId: 'root-nested-handoff',
      instruction: '完成需要协作的资料处理', triggerMessageId: 'message-nested-handoff',
      signal: new AbortController().signal, workspaceRoot: 'C:/tmp/project-nested-handoff',
      services: {
        async generateText() { return { text: delegated.length === 0
          ? 'NEED_AGENTS\nknowledge-1: 先完成资料处理并在需要时请求补充协作'
          : '已经根据完整协作结果完成处理。' }; },
        getToolDefinitions: () => [], async executeTool() { return ''; }, async createFileRecord() {},
        async insertMessage() { return 'result'; },
        async sendDelegationMessage(input) {
          delegated.push(input.targetAgentInstanceId);
          return { messageId: `message-${delegated.length}`, childRunIds: ['parent-child'] };
        },
        setRunStatus() {}, setResultMessage() {}, addRunEvent() {},
        getRunStatus: () => ({ status: 'completed', resultMessageId: 'parent-result' }),
        getRunDescendants: () => [{ runId: 'nested-child', agentInstanceId: 'researcher-1', status: nestedStatus, resultMessageId: 'nested-result' }],
        getParentRunId: () => null, getRunAgentInstanceId: () => null, getAgentDisplayName: () => '资料调研智能体',
        createSubRun: () => '', enqueueRun() {}, emitEvent() {}, storeMemory() {}, consolidateMemory: () => 0,
        extractLongTermMemory: () => 0, buildMemoryContext: () => '',
        async buildContextSnapshot() { return { snapshotChecksum: 'nested-handoff', messages: [] }; },
        async writeContextManifest() {}, getProjectRoot: () => 'C:/tmp/project-nested-handoff', renderSnapshotToText: () => '',
        getKmInstance: () => ({ id: 'knowledge-1', identityRelPath: null, profileEnabled: 1 }),
        getProjectDelegatableAgents: () => [
          { id: 'knowledge-1', name: '知识管理智能体', role: 'teammate', definitionId: 'builtin.knowledge-manager', runtimeMode: 'native-model' },
          { id: 'researcher-1', name: '资料调研智能体', role: 'teammate', definitionId: 'builtin.researcher', runtimeMode: 'native-model' },
        ],
        getMessageContent: () => '协作分支结果已返回。', getLogger: () => ({ info() {}, warn() {}, error() {} }),
      },
    };

    const timer = setTimeout(() => { nestedStatus = 'completed'; }, 5);
    await runOrchestrator(ctx);
    clearTimeout(timer);
    expect(delegated).toEqual(['knowledge-1']);
  });

  it('resolves a multi-turn file follow-up into a complete HTML deliverable task', async () => {
    expect(needsConversationTaskResolution('把上面的内容梳理成文件并发出来')).toBe(true);
    expect(needsConversationTaskResolution('标题改为内部发布版')).toBe(true);
    expect(needsConversationTaskResolution('发个文件')).toBe(true);
    expect(requiresHtmlDeliverable('把上面的内容梳理成文件并发出来')).toBe(true);
    expect(applyDeliverableDefaults('整理豆包 GEO 方案', '梳理成文件')).toContain('HTML 文件');

    let resolutionPrompt = '';
    const resolved = await resolveConversationTask({
      services: {
        async generateText(_slot, messages) {
          resolutionPrompt = messages.map((message) => message.content).join('\n');
          return { text: '{"resolvedTask":"基于前文已经确认的豆包 GEO 策略，整理为完整方案文件"}' };
        },
      },
    } as unknown as IGraphContext, {
      snapshotChecksum: 'multi-turn',
      messages: [
        { role: 'user', content: '分析豆包在生成式搜索中的 GEO 机会与落地策略' },
        ...Array.from({ length: 10 }, (_item, index) => ({ role: 'assistant' as const, content: `智能体过程消息 ${index + 1}` })),
        { role: 'user', content: '把上面的内容梳理成文件并发出来' },
      ],
    }, '把上面的内容梳理成文件并发出来');

    expect(resolutionPrompt).toContain('分析豆包在生成式搜索中的 GEO 机会与落地策略');
    expect(resolved).toContain('豆包 GEO');
    expect(resolved).toContain('outputs/');
    expect(resolved).toContain('群聊附件发布');
    expect(resolved).not.toBe('把上面的内容梳理成文件并发出来');
  });

  it('turns a natural invitation plan into a real knowledge delegation', async () => {
    const delegated: Array<{ target: string; instruction: string; visible?: string }> = [];
    const childResults = new Map<string, string>();
    const published: string[] = [];
    let generation = 0;
    const instruction = '那帮我整理一份参访邀请函，我要发给领导，注意要给出具体的地点，时间就定在明天早上10：30';
    const ctx: IGraphContext = {
      projectId: 'project-invitation', agentInstanceId: 'orchestrator-1', runId: 'root-invitation',
      instruction, triggerMessageId: 'message-invitation', signal: new AbortController().signal,
      workspaceRoot: 'C:/tmp/project-invitation',
      services: {
        async generateText() {
          generation += 1;
          if (generation === 1) return { text: '{"resolvedTask":"承接前一轮厦门科技局领导张三参访鲲鹭科技的接待任务，制作正式参访邀请函；时间为明天上午10:30，并从公司知识中确认具体地点和邀请函模板"}' };
          if (generation === 2) return { text: '我先安排知识管理智能体查找公司具体地址、邀请函模板和可引用的组织名称。' };
          if (generation === 3) return { text: JSON.stringify({
            status: 'delegate', reason: '地点和模板已经确认，需要形成正式邀请函待审稿',
            assignments: [{ agentInstanceId: 'writer-1', objective: '依据已确认的公司地址、来访对象和时间编写正式参访邀请函' }],
          }) };
          if (generation <= 6) return { text: JSON.stringify({ status: 'complete', reason: '当前步骤已经返回', assignments: [] }) };
          return { text: '邀请函已经核验定稿。具体地点和参访时间均已写入文件，最终附件已发送。' };
        },
        getToolDefinitions: () => [],
        async executeTool(name, args) {
          if (name !== 'review:promoteArtifact') return '';
          published.push(`${String(args.draftRelativePath)}=>${String(args.outputRelativePath)}`);
          return `验收通过的成果已发布到 ${String(args.outputRelativePath)}`;
        },
        async createFileRecord(_projectId, relativePath) { published.push(`card:${relativePath}`); },
        async insertMessage() { return 'invitation-final-message'; },
        async sendDelegationMessage(input) {
          delegated.push({ target: input.targetAgentInstanceId, instruction: input.instruction, visible: input.visibleInstruction });
          const childRunId = `invitation-child-${delegated.length}`;
          if (input.targetAgentInstanceId === 'knowledge-1') childResults.set(childRunId, '公司地址已核实为厦门市软件园二期观日路XX号；未找到固定邀请函模板。');
          if (input.targetAgentInstanceId === 'writer-1') childResults.set(childRunId, '邀请函待审稿已保存到 .runtime/review-drafts/root-invitation/material-draft.html。');
          if (input.targetAgentInstanceId === 'reviewer-1') childResults.set(childRunId, '已核对来访对象、具体地点、明日上午10:30和邀请函格式。\n验收结论：通过');
          return { messageId: `invitation-message-${delegated.length}`, childRunIds: [childRunId] };
        },
        setRunStatus() {}, setResultMessage() {}, addRunEvent() {},
        getRunStatus: (runId) => ({ status: 'completed', resultMessageId: `${runId}-result` }),
        getParentRunId: () => null, getRunAgentInstanceId: () => null, getAgentDisplayName: () => null,
        createSubRun: () => '', enqueueRun() {}, emitEvent() {}, storeMemory() {},
        consolidateMemory: () => 0, extractLongTermMemory: () => 0, buildMemoryContext: () => '',
        async buildContextSnapshot() { return { snapshotChecksum: 'snapshot-invitation', messages: [
          { role: 'user', content: '帮我写一份厦门科技局领导张三到访鲲鹭科技的接待安排文件' },
          { role: 'assistant', content: '接待安排文件已经完成并发送。' },
          { role: 'user', content: instruction },
        ] }; },
        async writeContextManifest() {}, getProjectRoot: () => 'C:/tmp/project-invitation', renderSnapshotToText: () => '',
        getKmInstance: () => ({ id: 'knowledge-1', identityRelPath: null, profileEnabled: 1 }),
        getProjectDelegatableAgents: () => [
          { id: 'knowledge-1', name: '知识管理智能体', role: 'teammate', definitionId: 'builtin.knowledge-manager', runtimeMode: 'native-model' },
          { id: 'writer-1', name: '材料编写智能体', role: 'teammate', definitionId: 'builtin.material-writer', runtimeMode: 'native-model' },
          { id: 'reviewer-1', name: '验收智能体', role: 'teammate', definitionId: 'builtin.acceptance-reviewer', runtimeMode: 'native-model' },
        ],
        getMessageContent: (messageId) => childResults.get(messageId.replace(/-result$/, '')) ?? null,
        getLogger: () => ({ info() {}, warn() {}, error() {} }),
      },
    };

    await runOrchestrator(ctx);

    expect(delegated.map((item) => item.target)).toEqual(['knowledge-1', 'writer-1', 'reviewer-1']);
    expect(delegated[0]?.instruction).toContain('详细地址');
    expect(delegated[0]?.instruction).toContain('邀请函模板');
    expect(delegated[0]?.visible).toContain('参访邀请函');
    expect(published).toContain('.runtime/review-drafts/root-invitation/material-draft.html=>outputs/task-delivery-root-invitation.html');
    expect(published).toContain('card:outputs/task-delivery-root-invitation.html');
  });

  it('keeps local clock questions direct but routes fresh weather through planning', () => {
    expect(isSimpleDirectTask('帮我查询一下今天上海天气')).toBe(false);
    expect(isSimpleDirectTask('现在几点？')).toBe(true);
    expect(isSimpleDirectTask('整理近三年天气数据并生成分析报告')).toBe(false);
  });

  it('recognizes material deliverables and requires an explicit acceptance result', () => {
    expect(requiresMaterialReviewWorkflow('请整理一份公司接待制度 HTML 报告')).toBe(true);
    expect(requiresArtifactDeliverable('请根据检索结果整理一份来访接待材料')).toBe(true);
    expect(requiresArtifactDeliverable('请查询来访接待制度有哪些规定')).toBe(false);
    expect(requiresQualityReview('请根据公司制度整理一份来访接待报告')).toBe(true);
    expect(requiresHtmlDeliverable('帮我写一份厦门科技局领导张三到访公司，鲲鹭科技的接待安排文件')).toBe(true);
    expect(requiresMaterialReviewWorkflow('帮我写一份厦门科技局领导张三到访公司，鲲鹭科技的接待安排文件')).toBe(true);
    expect(requiresMaterialReviewWorkflow('请生成一个 HTML 交互小游戏')).toBe(false);
    expect(requiresArtifactDeliverable('帮我整理一份参访邀请函，我要发给领导')).toBe(true);
    expect(requiresHtmlDeliverable('帮我整理一份参访邀请函，我要发给领导')).toBe(true);
    expect(requiresQualityReview('帮我整理一份参访邀请函，我要发给领导')).toBe(true);
    expect(isKnowledgeEvidenceMissing('当前群聊知识库和共享知识中没有找到能够回答接待安排的可靠证据。')).toBe(true);
    expect(isKnowledgeEvidenceMissing('当前群聊知识库和共享知识中没有找到能够回答“知识管理智能体 请在当前群聊的本地知识和共享知识中完成专题检索，不检索其他群聊私有内容。检索主题与扩展词：来访、接待、招待、领导来访、公务接待、陪同、食宿、车辆保障”返回的可靠证据。')).toBe(true);
    expect(isKnowledgeEvidenceMissing('已找到接待制度第 3 条，来源明确。')).toBe(false);
    expect(buildResearchFallbackTask('写一份接待安排文件')).toContain('公开资料');
    expect(parseAcceptanceDecision('事实与来源均已核对。\n\n验收结论：通过')).toBe('pass');
    expect(parseAcceptanceDecision('存在无来源数据。\n验收结论：不通过')).toBe('fail');
    expect(parseAcceptanceDecision('大体没有问题')).toBe('unknown');
  });

  it('removes HTML source from formal delivery and detects copied member replies', () => {
    const source = '已完成接待安排。\n```html\n<!doctype html><html><body><h1>接待安排</h1></body></html>\n```\n文件已发送。';
    expect(removeHtmlSourceFromFormalMessage(source)).toBe('已完成接待安排。\n\n文件已发送。');
    const member = '已找到接待制度，包括餐费标准、陪同要求和车辆安排。具体出处为制度第一章，仍需确认住宿标准。';
    expect(isNearDuplicateMemberSummary(member, [member])).toBe(true);
    expect(isNearDuplicateMemberSummary('我建议按制度标准执行，并在定稿中把住宿标准列为待确认项。', [member])).toBe(false);
  });

  it('uses adaptive planning to continue after local knowledge is missing', async () => {
    const delegated: Array<{ target: string; instruction: string }> = [];
    const committed: string[] = [];
    const published: string[] = [];
    let generation = 0;
    const runResults = new Map<string, string>();
    const ctx: IGraphContext = {
      projectId: 'project-reviewed-report',
      agentInstanceId: 'orchestrator-1',
      runId: 'root-reviewed-report',
      instruction: '依据公司制度整理一份来访接待规则 HTML 报告',
      triggerMessageId: 'user-reviewed-report',
      signal: new AbortController().signal,
      workspaceRoot: 'C:/tmp/project-reviewed-report',
      services: {
        async generateText() {
          generation += 1;
          if (generation === 1) {
            return { text: 'NEED_AGENTS\nknowledge-1: 检索来访接待制度证据、写作模板和必填字段' };
          }
          if (generation === 2) {
            return { text: JSON.stringify({
              status: 'delegate', reason: '本地制度暂未返回证据，改用公开资料补齐可引用内容',
              assignments: [{
                agentInstanceId: 'researcher-1',
                objective: '检索公开来源中的来访接待通行规则，区分可确认事实与待确认项',
                expectedDeliverable: '带来源的事实摘要和待确认清单',
                visibleMessage: '本地资料暂时没有覆盖这部分，请补充公开来源中的通行规则和待确认项。',
              }],
            }) };
          }
          if (generation === 3) {
            return { text: JSON.stringify({
              status: 'delegate', reason: '证据已经补齐，需要形成用户要求的成果文件',
              assignments: [{
                agentInstanceId: 'writer-1',
                objective: '根据现有证据整理来访接待规则并生成正式 HTML 文件',
                inputs: '使用知识检索和公开调研已经返回的内容，所有未确认项明确标注',
                expectedDeliverable: 'outputs/reception-rules.html',
                visibleMessage: '依据已经补齐的资料整理成正式接待规则文件，未确认内容请清楚标注。',
              }],
            }) };
          }
          return { text: '接待规则文件已经整理完成并发送。' };
        },
        getToolDefinitions: () => [],
        async executeTool(name, args) {
          if (name !== 'review:promoteArtifact') return '';
          published.push(`${String(args.draftRelativePath)}=>${String(args.outputRelativePath)}`);
          return `验收通过的成果已发布到 ${String(args.outputRelativePath)}`;
        },
        async createFileRecord(_projectId, relativePath) { published.push(`card:${relativePath}`); },
        async insertMessage(_projectId, _senderId, _kind, contentJson) { committed.push(contentJson); return 'final-reviewed-message'; },
        async sendDelegationMessage(input) {
          delegated.push({ target: input.targetAgentInstanceId, instruction: input.instruction });
          const sequence = delegated.length;
          const childRunId = `child-${sequence}`;
          if (input.targetAgentInstanceId === 'knowledge-1') {
            runResults.set(childRunId, '当前群聊知识库和共享知识中没有找到能够回答接待安排的可靠证据。');
          } else if (input.targetAgentInstanceId === 'researcher-1') {
            runResults.set(childRunId, '公开资料补充：公务接待通常需要提前确认来访信息、接待级别、陪同人员、会议安排、用车和费用边界；具体公司制度待确认。');
          } else if (input.targetAgentInstanceId === 'writer-1') {
            runResults.set(childRunId, '已根据现有证据完成待审稿，保存于 .runtime/review-drafts/root-reviewed-report/material-draft.html。');
          } else if (input.targetAgentInstanceId === 'reviewer-1') {
            runResults.set(childRunId, '已经逐项核对用户要求、证据和文件内容。\n验收结论：通过');
          } else {
            runResults.set(childRunId, '未预期的成员任务');
          }
          return { messageId: `delegation-${sequence}`, childRunIds: [childRunId] };
        },
        setRunStatus() {},
        setResultMessage() {},
        addRunEvent() {},
        getRunStatus: (runId) => ({ status: 'completed', resultMessageId: `${runId}-result` }),
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
        async buildContextSnapshot() { return { snapshotChecksum: 'reviewed-report', messages: [] }; },
        async writeContextManifest() {},
        getProjectRoot: () => 'C:/tmp/project-reviewed-report',
        renderSnapshotToText: () => '',
        getKmInstance: () => ({ id: 'knowledge-1', identityRelPath: null, profileEnabled: 1 }),
        getProjectDelegatableAgents: () => [
          { id: 'knowledge-1', name: '知识管理智能体', role: 'teammate', definitionId: 'builtin.knowledge-manager', runtimeMode: 'native-model' },
          { id: 'researcher-1', name: '资料调研智能体', role: 'teammate', definitionId: 'builtin.researcher', runtimeMode: 'native-model' },
          { id: 'writer-1', name: '材料编写智能体', role: 'teammate', definitionId: 'builtin.material-writer', runtimeMode: 'native-model' },
          { id: 'reviewer-1', name: '验收智能体', role: 'teammate', definitionId: 'builtin.acceptance-reviewer', runtimeMode: 'native-model' },
        ],
        getMessageContent: (messageId) => runResults.get(messageId.replace(/-result$/, '')) ?? null,
        getLogger: () => ({ info() {}, warn() {}, error() {} }),
      },
    };

    await runOrchestrator(ctx);

    expect(delegated.map((item) => item.target)).toEqual([
      'knowledge-1',
      'researcher-1',
      'writer-1',
      'reviewer-1',
    ]);
    expect(delegated[1]?.instruction).toContain('公开来源');
    expect(delegated[2]?.instruction).toContain('.runtime/review-drafts/root-reviewed-report/material-draft.html');
    expect(published).toContain('.runtime/review-drafts/root-reviewed-report/material-draft.html=>outputs/task-delivery-root-reviewed-report.html');
    expect(published).toContain('card:outputs/task-delivery-root-reviewed-report.html');
    expect(JSON.parse(committed[0]!).text).toContain('接待规则文件已经整理完成');
  });

  it('keeps one root loop through evidence, drafting, failed review, repair, approval, and publication', async () => {
    const delegated: Array<{ target: string; instruction: string }> = [];
    const childResults = new Map<string, string>();
    const published: string[] = [];
    const committed: string[] = [];
    let generation = 0;
    let writerPass = 0;
    let reviewerPass = 0;
    const rawKnowledge = '内部制度证据：接待前需确认来访名单、陪同人员和会议安排。';
    const rawResearch = '公开调研证据：通行做法还包括车辆、餐饮和应急联系人确认。';
    const ctx: IGraphContext = {
      projectId: 'project-full-root-loop',
      agentInstanceId: 'orchestrator-1',
      runId: 'root-full-loop',
      instruction: '结合公司制度和公开资料，整理一份来访接待安排 HTML 报告',
      triggerMessageId: 'user-full-root-loop',
      signal: new AbortController().signal,
      workspaceRoot: 'C:/tmp/project-full-root-loop',
      services: {
        async generateText() {
          generation += 1;
          if (generation === 1) {
            return { text: JSON.stringify({
              status: 'delegate',
              reason: '内部规则和外部做法彼此独立，可以并行取证',
              assignments: [
                { stepId: 'local-evidence', agentInstanceId: 'knowledge-1', objective: '检索公司来访接待制度、模板及准确出处', parallelGroup: 'evidence' },
                { stepId: 'public-evidence', agentInstanceId: 'researcher-1', objective: '检索公开来源中的来访接待通行做法和风险点', parallelGroup: 'evidence' },
              ],
            }) };
          }
          if (generation === 2) {
            return { text: JSON.stringify({
              status: 'delegate',
              reason: '证据已经齐备，下一步形成候选成果',
              assignments: [{ agentInstanceId: 'writer-1', objective: '依据两类证据编写完整 HTML 待审稿' }],
            }) };
          }
          if (generation <= 6) {
            return { text: JSON.stringify({ status: 'complete', reason: '当前成员步骤已经返回', assignments: [] }) };
          }
          return { text: '报告已经完成核验，最终文件已发送。' };
        },
        getToolDefinitions: () => [],
        async executeTool(name, args) {
          if (name !== 'review:promoteArtifact') return '';
          published.push(`${String(args.draftRelativePath)}=>${String(args.outputRelativePath)}`);
          return `验收通过的成果已发布到 ${String(args.outputRelativePath)}`;
        },
        async createFileRecord(_projectId, relativePath) { published.push(`card:${relativePath}`); },
        async insertMessage(_projectId, _senderId, _kind, contentJson) {
          committed.push(contentJson);
          return 'full-loop-final-message';
        },
        async sendDelegationMessage(input) {
          delegated.push({ target: input.targetAgentInstanceId, instruction: input.instruction });
          const childRunId = `full-loop-child-${delegated.length}`;
          if (input.targetAgentInstanceId === 'knowledge-1') childResults.set(childRunId, rawKnowledge);
          if (input.targetAgentInstanceId === 'researcher-1') childResults.set(childRunId, rawResearch);
          if (input.targetAgentInstanceId === 'writer-1') {
            writerPass += 1;
            childResults.set(childRunId, writerPass === 1
              ? '候选报告已保存到 .runtime/review-drafts/root-full-loop/material-draft.html。'
              : '已修正制度出处和待确认项，更新后的候选报告仍保存于 .runtime/review-drafts/root-full-loop/material-draft.html。');
          }
          if (input.targetAgentInstanceId === 'reviewer-1') {
            reviewerPass += 1;
            childResults.set(childRunId, reviewerPass === 1
              ? '制度出处标注不完整，请补齐来源并明确待确认项。\n验收结论：不通过'
              : '制度出处和待确认项已经逐项核对。\n验收结论：通过');
          }
          return { messageId: `full-loop-delegation-${delegated.length}`, childRunIds: [childRunId] };
        },
        setRunStatus() {},
        setResultMessage() {},
        addRunEvent() {},
        getRunStatus: (runId) => ({ status: 'completed', resultMessageId: `${runId}-result` }),
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
        async buildContextSnapshot() { return { snapshotChecksum: 'full-root-loop', messages: [] }; },
        async writeContextManifest() {},
        getProjectRoot: () => 'C:/tmp/project-full-root-loop',
        renderSnapshotToText: () => '',
        getKmInstance: () => ({ id: 'knowledge-1', identityRelPath: null, profileEnabled: 1 }),
        getProjectDelegatableAgents: () => [
          { id: 'knowledge-1', name: '知识管理智能体', role: 'teammate', definitionId: 'builtin.knowledge-manager', runtimeMode: 'native-model' },
          { id: 'researcher-1', name: '资料调研智能体', role: 'teammate', definitionId: 'builtin.researcher', runtimeMode: 'native-model' },
          { id: 'writer-1', name: '材料编写智能体', role: 'teammate', definitionId: 'builtin.material-writer', runtimeMode: 'native-model' },
          { id: 'reviewer-1', name: '验收智能体', role: 'teammate', definitionId: 'builtin.acceptance-reviewer', runtimeMode: 'native-model' },
        ],
        getMessageContent: (messageId) => childResults.get(messageId.replace(/-result$/, '')) ?? null,
        getLogger: () => ({ info() {}, warn() {}, error() {} }),
      },
    };

    await runOrchestrator(ctx);

    expect(delegated.map((item) => item.target)).toEqual([
      'knowledge-1',
      'researcher-1',
      'writer-1',
      'reviewer-1',
      'writer-1',
      'reviewer-1',
    ]);
    expect(delegated[4]?.instruction).toContain('制度出处标注不完整');
    expect(delegated[5]?.instruction).toContain('更新后的候选报告');
    expect(published).toContain('.runtime/review-drafts/root-full-loop/material-draft.html=>outputs/task-delivery-root-full-loop.html');
    expect(published).toContain('card:outputs/task-delivery-root-full-loop.html');
    expect(committed).toHaveLength(1);
    const finalText = JSON.parse(committed[0]!).text as string;
    expect(finalText).toContain('报告已经完成核验');
    expect(finalText).not.toBe(rawKnowledge);
    expect(finalText).not.toBe(rawResearch);
  });

  it('uses a researcher for current weather and lets the root orchestrator answer once', async () => {
    const delegated: string[] = [];
    const committed: string[] = [];
    const researcherResult = '上海当前 31 摄氏度，多云，观测时间 10:00，来源：公开天气服务。';
    let generation = 0;
    const ctx: IGraphContext = {
      projectId: 'project-current-weather',
      agentInstanceId: 'orchestrator-1',
      runId: 'root-current-weather',
      instruction: '今天天气如何？',
      triggerMessageId: 'user-current-weather',
      signal: new AbortController().signal,
      workspaceRoot: 'C:/tmp/project-current-weather',
      services: {
        async generateText() {
          generation += 1;
          if (generation === 1) {
            return { text: JSON.stringify({
              status: 'delegate',
              reason: '需要取得实时天气信息',
              assignments: [{ agentInstanceId: 'researcher-1', objective: '查询今天上海的实时天气、观测时间和来源' }],
            }) };
          }
          if (generation === 2) return { text: JSON.stringify({ status: 'complete', reason: '实时信息已经取得', assignments: [] }) };
          return { text: '上海今天多云，当前约 31 摄氏度。天气信息观测于 10:00，出行建议注意防晒并留意临近预报。' };
        },
        getToolDefinitions: () => [],
        async executeTool() { return ''; },
        async createFileRecord() {},
        async insertMessage(_projectId, _senderId, _kind, contentJson) { committed.push(contentJson); return 'weather-final-message'; },
        async sendDelegationMessage(input) {
          delegated.push(input.targetAgentInstanceId);
          return { messageId: 'weather-delegation', childRunIds: ['weather-child'] };
        },
        setRunStatus() {},
        setResultMessage() {},
        addRunEvent() {},
        getRunStatus: () => ({ status: 'completed', resultMessageId: 'weather-child-result' }),
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
        async buildContextSnapshot() { return { snapshotChecksum: 'current-weather', messages: [] }; },
        async writeContextManifest() {},
        getProjectRoot: () => 'C:/tmp/project-current-weather',
        renderSnapshotToText: () => '',
        getKmInstance: () => undefined,
        getProjectDelegatableAgents: () => [
          { id: 'knowledge-1', name: '知识管理智能体', role: 'teammate', definitionId: 'builtin.knowledge-manager', runtimeMode: 'native-model' },
          { id: 'researcher-1', name: '资料调研智能体', role: 'teammate', definitionId: 'builtin.researcher', runtimeMode: 'native-model' },
          { id: 'writer-1', name: '材料编写智能体', role: 'teammate', definitionId: 'builtin.material-writer', runtimeMode: 'native-model' },
          { id: 'reviewer-1', name: '验收智能体', role: 'teammate', definitionId: 'builtin.acceptance-reviewer', runtimeMode: 'native-model' },
        ],
        getMessageContent: () => researcherResult,
        getLogger: () => ({ info() {}, warn() {}, error() {} }),
      },
    };

    await runOrchestrator(ctx);

    expect(delegated).toEqual(['researcher-1']);
    expect(committed).toHaveLength(1);
    const finalText = JSON.parse(committed[0]!).text as string;
    expect(finalText).toContain('上海今天多云');
    expect(finalText).not.toBe(researcherResult);
  });

  it('turns a narrated JSON code-block assignment using an agent name into a real delegation', async () => {
    const delegated: Array<{ target: string; visible?: string }> = [];
    const committed: string[] = [];
    let generation = 0;
    const ctx: IGraphContext = {
      projectId: 'project-address-check',
      agentInstanceId: 'orchestrator-1',
      runId: 'root-address-check',
      instruction: '这个公司地址是对的吗，这个1003室09单元，你仔细检查一下',
      triggerMessageId: 'user-address-check',
      signal: new AbortController().signal,
      workspaceRoot: 'C:/tmp/project-address-check',
      services: {
        async generateText() {
          generation += 1;
          if (generation === 1) return { text: `我先请资料调研智能体复核公开登记信息。\n\n\`\`\`json\n${JSON.stringify({
            status: 'delegate',
            assignments: [{
              agentInstanceId: '资料调研智能体',
              objective: '核实厦门鲲鹭物联信息技术有限公司的最新登记地址，重点确认1003室09单元是否准确',
              expectedDeliverable: '返回可靠完整地址、来源和异常说明',
              visibleMessage: '帮我复核最新工商登记地址，重点确认“1003室09单元”是否准确，并带回可靠来源。',
            }],
          })}\n\`\`\`` };
          if (generation === 2) return { text: JSON.stringify({ status: 'complete', reason: '地址已经复核', assignments: [] }) };
          return { text: '我已重新核对公开登记信息：“1003室09单元”需要以最新工商登记来源为准，发送邀请函前应使用调研结果中的完整地址。' };
        },
        getToolDefinitions: () => [],
        async executeTool() { return ''; },
        async createFileRecord() {},
        async insertMessage(_projectId, _senderId, _kind, contentJson) { committed.push(contentJson); return 'address-final-message'; },
        async sendDelegationMessage(input) {
          delegated.push({ target: input.targetAgentInstanceId, visible: input.visibleInstruction });
          return { messageId: 'address-delegation', childRunIds: ['address-child'] };
        },
        setRunStatus() {}, setResultMessage() {}, addRunEvent() {},
        getRunStatus: () => ({ status: 'completed', resultMessageId: 'address-child-result' }),
        getParentRunId: () => null, getRunAgentInstanceId: () => null, getAgentDisplayName: () => null,
        createSubRun: () => '', enqueueRun() {}, emitEvent() {}, storeMemory() {},
        consolidateMemory: () => 0, extractLongTermMemory: () => 0, buildMemoryContext: () => '',
        async buildContextSnapshot() { return { snapshotChecksum: 'address-check', messages: [] }; },
        async writeContextManifest() {}, getProjectRoot: () => 'C:/tmp/project-address-check', renderSnapshotToText: () => '',
        getKmInstance: () => undefined,
        getProjectDelegatableAgents: () => [
          { id: 'researcher-1', name: '资料调研智能体', role: 'teammate', definitionId: 'builtin.researcher', runtimeMode: 'native-model' },
        ],
        getMessageContent: () => '最新公开登记地址已核实，附权威来源和登记日期。',
        getLogger: () => ({ info() {}, warn() {}, error() {} }),
      },
    };

    await runOrchestrator(ctx);

    expect(delegated).toHaveLength(1);
    expect(delegated[0]?.target).toBe('researcher-1');
    expect(delegated[0]?.visible).toContain('1003室09单元');
    expect(delegated[0]?.visible).toContain('来源');
    expect(committed).toHaveLength(1);
    expect(JSON.parse(committed[0]!).text).not.toContain('```json');
  });

  it('lets the root orchestrator execute an unmatched step and then re-evaluate completion', async () => {
    const delegated: string[] = [];
    const committed: string[] = [];
    let generation = 0;
    const ctx: IGraphContext = {
      projectId: 'project-root-self-execute',
      agentInstanceId: 'orchestrator-1',
      runId: 'root-self-execute',
      instruction: '比较这两个已经给出的方案，告诉我更适合小团队的是哪个',
      triggerMessageId: 'user-root-self-execute',
      signal: new AbortController().signal,
      workspaceRoot: 'C:/tmp/project-root-self-execute',
      services: {
        async generateText() {
          generation += 1;
          if (generation === 1) return { text: JSON.stringify({
            status: 'self_execute',
            reason: '这是基于现有上下文的判断，不需要额外专业成员',
            assignments: [],
            selfInstruction: '比较已有两个方案的实施成本、协作复杂度和小团队适配度，给出明确选择',
          }) };
          if (generation === 2) return { text: '方案 A 更适合小团队：实施成本较低，协作环节更少。' };
          if (generation === 3) return { text: JSON.stringify({ status: 'complete', reason: '比较结论已经形成', assignments: [] }) };
          return { text: '更建议选择方案 A。它的实施成本和协作复杂度都更适合小团队。' };
        },
        getToolDefinitions: () => [],
        async executeTool() { return ''; },
        async createFileRecord() {},
        async insertMessage(_projectId, _senderId, _kind, contentJson) { committed.push(contentJson); return 'self-execute-final'; },
        async sendDelegationMessage(input) { delegated.push(input.targetAgentInstanceId); return { messageId: 'unexpected', childRunIds: [] }; },
        setRunStatus() {},
        setResultMessage() {},
        addRunEvent() {},
        getRunStatus: () => ({ status: 'completed' }),
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
        async buildContextSnapshot() { return { snapshotChecksum: 'root-self-execute', messages: [] }; },
        async writeContextManifest() {},
        getProjectRoot: () => 'C:/tmp/project-root-self-execute',
        renderSnapshotToText: () => '',
        getKmInstance: () => undefined,
        getProjectDelegatableAgents: () => [],
        getMessageContent: () => null,
        getLogger: () => ({ info() {}, warn() {}, error() {} }),
      },
    };

    await runOrchestrator(ctx);

    expect(delegated).toHaveLength(0);
    expect(generation).toBe(4);
    expect(committed).toHaveLength(1);
    expect(JSON.parse(committed[0]!).text).toContain('方案 A');
  });

  it('does not expose an initial planner complete decision as the user reply', async () => {
    const committed: string[] = [];
    let generation = 0;
    const ctx: IGraphContext = {
      projectId: 'project-initial-complete', agentInstanceId: 'orchestrator-1', runId: 'root-initial-complete',
      instruction: '解释一下为什么小团队要减少沟通层级', triggerMessageId: 'user-initial-complete',
      signal: new AbortController().signal, workspaceRoot: 'C:/tmp/project-initial-complete',
      services: {
        async generateText() {
          generation += 1;
          if (generation === 1) return { text: JSON.stringify({ status: 'complete', reason: '现有知识可以直接回答', assignments: [] }) };
          if (generation === 2) return { text: '沟通层级越少，信息损耗和等待时间通常越低，责任边界也更清楚。' };
          if (generation === 3) return { text: JSON.stringify({ status: 'complete', reason: '回答已经形成', assignments: [] }) };
          return { text: '小团队减少沟通层级，主要是为了降低信息损耗和等待成本，同时让责任更清晰。' };
        },
        getToolDefinitions: () => [], async executeTool() { return ''; }, async createFileRecord() {},
        async insertMessage(_projectId, _senderId, _kind, contentJson) { committed.push(contentJson); return 'initial-complete-final'; },
        async sendDelegationMessage() { return { messageId: 'unexpected', childRunIds: [] }; },
        setRunStatus() {}, setResultMessage() {}, addRunEvent() {}, getRunStatus: () => ({ status: 'completed' }),
        getParentRunId: () => null, getRunAgentInstanceId: () => null, getAgentDisplayName: () => null,
        createSubRun: () => '', enqueueRun() {}, emitEvent() {}, storeMemory() {}, consolidateMemory: () => 0,
        extractLongTermMemory: () => 0, buildMemoryContext: () => '',
        async buildContextSnapshot() { return { snapshotChecksum: 'initial-complete', messages: [] }; },
        async writeContextManifest() {}, getProjectRoot: () => 'C:/tmp/project-initial-complete', renderSnapshotToText: () => '',
        getKmInstance: () => undefined, getProjectDelegatableAgents: () => [], getMessageContent: () => null,
        getLogger: () => ({ info() {}, warn() {}, error() {} }),
      },
    };

    await runOrchestrator(ctx);

    expect(generation).toBe(4);
    expect(committed).toHaveLength(1);
    const finalText = JSON.parse(committed[0]!).text as string;
    expect(finalText).toContain('信息损耗');
    expect(finalText).not.toContain('"status"');
  });

  it('does not treat successful knowledge retrieval as the final delivery for a material task', async () => {
    const delegated: Array<{ target: string; instruction: string }> = [];
    const results = new Map<string, string>();
    const published: string[] = [];
    let generation = 0;
    const ctx: IGraphContext = {
      projectId: 'project-knowledge-is-input',
      agentInstanceId: 'orchestrator-1',
      runId: 'root-knowledge-is-input',
      instruction: '根据公司制度整理一份来访接待 HTML 报告',
      triggerMessageId: 'user-knowledge-is-input',
      signal: new AbortController().signal,
      workspaceRoot: 'C:/tmp/project-knowledge-is-input',
      services: {
        async generateText() {
          generation += 1;
          if (generation === 1) {
            return { text: JSON.stringify({
              status: 'delegate',
              reason: '先取得本地制度依据',
              assignments: [{ agentInstanceId: 'knowledge-1', objective: '检索来访接待制度的适用范围、标准、流程和出处' }],
            }) };
          }
          if (generation <= 4) {
            return { text: JSON.stringify({ status: 'complete', reason: '当前阶段已经有结果', assignments: [] }) };
          }
          return { text: '接待报告已经整理、验收并发送。' };
        },
        getToolDefinitions: () => [],
        async executeTool(name, args) {
          if (name !== 'review:promoteArtifact') return '';
          published.push(`${String(args.draftRelativePath)}=>${String(args.outputRelativePath)}`);
          return `验收通过的成果已发布到 ${String(args.outputRelativePath)}`;
        },
        async createFileRecord(_projectId, relativePath) { published.push(`card:${relativePath}`); },
        async insertMessage() { return 'final-knowledge-is-input'; },
        async sendDelegationMessage(input) {
          delegated.push({ target: input.targetAgentInstanceId, instruction: input.instruction });
          const childRunId = `child-knowledge-is-input-${delegated.length}`;
          if (input.targetAgentInstanceId === 'knowledge-1') {
            results.set(childRunId, '已找到《来访接待管理制度》第 2 至 6 条，包括接待分级、陪同、会议、用车和费用边界。知识摘要文件位于 outputs/knowledge-retrieval.html。');
          } else if (input.targetAgentInstanceId === 'writer-1') {
            results.set(childRunId, '已依据制度证据完成待审稿，保存于 .runtime/review-drafts/root-knowledge-is-input/material-draft.html。');
          } else if (input.targetAgentInstanceId === 'reviewer-1') {
            results.set(childRunId, '文件内容、条款来源和用户要求均已核对。\n验收结论：通过');
          }
          return { messageId: `message-${delegated.length}`, childRunIds: [childRunId] };
        },
        setRunStatus() {},
        setResultMessage() {},
        addRunEvent() {},
        getRunStatus: (runId) => ({ status: 'completed', resultMessageId: `${runId}-result` }),
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
        async buildContextSnapshot() { return { snapshotChecksum: 'knowledge-is-input', messages: [] }; },
        async writeContextManifest() {},
        getProjectRoot: () => 'C:/tmp/project-knowledge-is-input',
        renderSnapshotToText: () => '',
        getKmInstance: () => ({ id: 'knowledge-1', identityRelPath: null, profileEnabled: 1 }),
        getProjectDelegatableAgents: () => [
          { id: 'knowledge-1', name: '知识管理智能体', role: 'teammate', definitionId: 'builtin.knowledge-manager', runtimeMode: 'native-model' },
          { id: 'writer-1', name: '材料编写智能体', role: 'teammate', definitionId: 'builtin.material-writer', runtimeMode: 'native-model' },
          { id: 'reviewer-1', name: '验收智能体', role: 'teammate', definitionId: 'builtin.acceptance-reviewer', runtimeMode: 'native-model' },
        ],
        getMessageContent: (messageId) => results.get(messageId.replace(/-result$/, '')) ?? null,
        getLogger: () => ({ info() {}, warn() {}, error() {} }),
      },
    };

    await runOrchestrator(ctx);

    expect(delegated.map((item) => item.target)).toEqual(['knowledge-1', 'writer-1', 'reviewer-1']);
    expect(delegated[1]?.instruction).toContain('来访接待管理制度');
    expect(delegated[1]?.instruction).toContain('.runtime/review-drafts/root-knowledge-is-input/material-draft.html');
    expect(delegated[2]?.instruction).toContain('.runtime/review-drafts/root-knowledge-is-input/material-draft.html');
    expect(published).toContain('.runtime/review-drafts/root-knowledge-is-input/material-draft.html=>outputs/task-delivery-root-knowledge-is-input.html');
    expect(published).toContain('card:outputs/task-delivery-root-knowledge-is-input.html');
  });

  it('distinguishes conversation status questions from follow-up work commands', () => {
    expect(isConversationStatusQuestion('刚才做了什么？')).toBe(true);
    expect(isConversationStatusQuestion('上一步完成了哪些内容？')).toBe(true);
    expect(isConversationStatusQuestion('现在进展怎么样？')).toBe(true);
    expect(isConversationStatusQuestion('刚才是谁生成的文件？')).toBe(true);

    expect(isConversationStatusQuestion('把刚才的内容整理成文件')).toBe(false);
    expect(isConversationStatusQuestion('继续刚才的任务')).toBe(false);
    expect(isConversationStatusQuestion('修改刚才生成的报告')).toBe(false);
  });

  it('answers a conversation status question from recent messages without resolving or delegating a task', async () => {
    const generationPrompts: string[] = [];
    const delegated: string[] = [];
    const committed: string[] = [];
    const runEvents: string[] = [];
    const ctx: IGraphContext = {
      projectId: 'project-status-question',
      agentInstanceId: 'orchestrator-1',
      runId: 'run-status-question',
      instruction: '刚才做了什么？',
      triggerMessageId: 'message-status-question',
      signal: new AbortController().signal,
      workspaceRoot: 'C:/tmp/project-status-question',
      services: {
        async generateText(_slot, messages) {
          generationPrompts.push(messages.map((message) => message.content).join('\n'));
          return { text: '刚才已经完成资料检索，并生成了一份接待安排文件。' };
        },
        getToolDefinitions: () => [],
        async executeTool() { return ''; },
        async createFileRecord() {},
        async insertMessage(_projectId, _senderId, _kind, contentJson) {
          committed.push(contentJson);
          return 'status-answer-message';
        },
        async sendDelegationMessage(input) {
          delegated.push(input.targetAgentInstanceId);
          return { messageId: 'unexpected-delegation', childRunIds: [] };
        },
        setRunStatus() {},
        setResultMessage() {},
        addRunEvent(_runId, type) { runEvents.push(type); },
        getRunStatus: () => ({ status: 'completed' }),
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
        async buildContextSnapshot() {
          return {
            snapshotChecksum: 'snapshot-status-question',
            messages: [
              { role: 'user', content: '帮我整理来访接待规则并生成文件' },
              { role: 'assistant', senderName: '知识管理智能体', content: '资料检索已完成，接待安排文件已生成并发送。' },
              { role: 'user', content: '刚才做了什么？' },
            ],
          };
        },
        async writeContextManifest() {},
        getProjectRoot: () => 'C:/tmp/project-status-question',
        renderSnapshotToText: () => '',
        getKmInstance: () => undefined,
        getProjectDelegatableAgents: () => [
          { id: 'codebuddy-1', name: 'CodeBuddy', role: 'teammate', definitionId: 'custom.codebuddy', runtimeMode: 'external-cli', capabilities: '生成文件' },
        ],
        getMessageContent: () => null,
        getLogger: () => ({ info() {}, warn() {}, error() {} }),
      },
    };

    await runOrchestrator(ctx);

    expect(generationPrompts).toHaveLength(1);
    expect(generationPrompts[0]).toContain('资料检索已完成');
    expect(generationPrompts[0]).toContain('知识管理智能体');
    expect(delegated).toHaveLength(0);
    expect(committed).toHaveLength(1);
    expect(JSON.parse(committed[0]!).text).toContain('已经完成资料检索');
    expect(runEvents).not.toContain('run.checklist');
  });

  it('translates a local reception question into searchable knowledge work', () => {
    const task = buildKnowledgeManagerTask('帮我查下具体的市级领导的来访接待规格');
    expect(task).toContain('来访');
    expect(task).toContain('接待');
    expect(task).toContain('招待');
    expect(task).toContain('陪同');
    expect(task).toContain('食宿');
    expect(task).toContain('车辆保障');
    expect(task).toContain('条款原文');
    expect(task).not.toContain('NEED_KM');
  });

  it('curates substantial report work when a deliverable exists', () => {
    expect(shouldCurateKnowledge({
      projectId: 'p', agentInstanceId: 'a', runId: 'r', triggerMessageId: 'm',
      instruction: '分析某品牌的市场机会并生成一份完整 HTML 方案报告', messages: [],
      subAgentResult: '成果文件位于 outputs/report.html。', finalResponse: '',
      needsKnowledgeManager: false, needsCLIDelegation: true, cliDelegations: [], recoveryCount: 0,
      knowledgeCurated: false, artifacts: [],
    })).toBe(true);
  });

  it('detects internal routing protocols before they enter formal chat messages', () => {
    expect(containsInternalOrchestrationProtocol('NEED_AGENTS codebuddy: 请继续发布成果')).toBe(true);
    expect(containsInternalOrchestrationProtocol('处理完成，成果已经发布。')).toBe(false);
  });

  it('uses an independently worded attachment summary instead of copying a member result', () => {
    const fallback = buildSafeSynthesisFallback(
      '--- codebuddy 结果 ---\n页面已经完成，文件位于 outputs/report.html。',
      '请制作一份 HTML 报告',
    );
    expect(fallback).toBe('我已核对本轮协作结果，最终成果文件已经发送：`outputs/report.html`。');
    expect(fallback).not.toContain('页面已经完成');
    expect(fallback).not.toContain('NEED_AGENTS');
  });

  it('removes leaked protocol lines from a fallback result', () => {
    const fallback = buildSafeSynthesisFallback(
      'NEED_AGENTS worker: 请重新处理\n\n现有成果位于 outputs/report.html。',
      '请制作一份 HTML 报告',
    );
    expect(fallback).toBe('我已核对本轮协作结果，最终成果文件已经发送：`outputs/report.html`。');
    expect(fallback).not.toContain('请重新处理');
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

  it('respects the model-selected member without forcing post-task knowledge capture', async () => {
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
            : { text: '报告已经完成，成果文件位于 outputs/report.html。' };
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
        getMessageContent: (messageId) => `已完成：${messageId}，成果文件位于 outputs/report.html。`,
        getLogger: () => ({ info() {}, warn() {}, error() {} }),
      },
    };

    await runOrchestrator(ctx);

    expect(delegated.map((item) => item.target)).toEqual(['codebuddy-1']);
    expect(delegated[0]?.instruction).toContain('分析某品牌的市场机会');
    expect(delegated[0]?.instruction).toContain('outputs/');
    expect(delegated.filter((item) => item.target === 'knowledge-1')).toHaveLength(0);
  });

  it('repairs a copied follow-up into a complete target-specific work package', async () => {
    const delegated: string[] = [];
    const planningPrompts: string[] = [];
    let generation = 0;
    const ctx: IGraphContext = {
      projectId: 'project-multi-turn',
      agentInstanceId: 'orchestrator-1',
      runId: 'root-multi-turn',
      instruction: '发个文件',
      triggerMessageId: 'user-follow-up',
      signal: new AbortController().signal,
      workspaceRoot: 'C:/tmp/project-multi-turn',
      services: {
        async generateText(_slot, messages) {
          generation += 1;
          planningPrompts.push(messages.map((message) => message.content).join('\n'));
          if (generation === 1) {
            return { text: '{"resolvedTask":"把前文已经确认的新员工欢迎词整理为正式成果文件"}' };
          }
          return { text: 'NEED_AGENTS\ncodebuddy-1: 发个文件' };
        },
        getToolDefinitions: () => [],
        async executeTool() { return ''; },
        async createFileRecord() {},
        async insertMessage() { return 'result-message'; },
        async sendDelegationMessage(input) {
          delegated.push(input.instruction);
          return { messageId: 'delegation-message', childRunIds: ['child-run'] };
        },
        setRunStatus() {},
        setResultMessage() {},
        addRunEvent() {},
        getRunStatus: () => ({ status: 'completed', resultMessageId: 'child-result' }),
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
        async buildContextSnapshot() {
          return {
            snapshotChecksum: 'snapshot-multi-turn',
            messages: [
              { role: 'user', content: '帮我拟一份面向研发团队的新员工欢迎词，语气专业友好' },
              { role: 'assistant', content: '欢迎词内容已经确认。' },
              { role: 'user', content: '发个文件' },
            ],
          };
        },
        async writeContextManifest() {},
        getProjectRoot: () => 'C:/tmp/project-multi-turn',
        renderSnapshotToText: () => '',
        getKmInstance: () => undefined,
        getProjectDelegatableAgents: () => [
          { id: 'codebuddy-1', name: 'CodeBuddy', role: 'teammate', definitionId: 'custom.codebuddy', runtimeMode: 'external-cli', capabilities: 'HTML 和文件成果生成' },
        ],
        getMessageContent: () => '欢迎词已整理完成，成果文件位于 outputs/new-employee-welcome.html。',
        getLogger: () => ({ info() {}, warn() {}, error() {} }),
      },
    };

    await runOrchestrator(ctx);

    expect(planningPrompts[1]).toContain('新员工欢迎词');
    expect(delegated).toHaveLength(1);
    expect(delegated[0]).toContain('新员工欢迎词');
    expect(delegated[0]).toContain('outputs/');
    expect(delegated[0]).not.toBe('发个文件');
  });

  it('retrieves company制度 first and lets the orchestrator publish HTML when no materializer is available', async () => {
    const delegatedTargets: string[] = [];
    const published: string[] = [];
    let generation = 0;
    const ctx: IGraphContext = {
      projectId: 'project-knowledge-delivery',
      agentInstanceId: 'orchestrator-1',
      runId: 'root-knowledge-delivery',
      instruction: '发文件',
      triggerMessageId: 'user-knowledge-follow-up',
      signal: new AbortController().signal,
      workspaceRoot: 'C:/tmp/project-knowledge-delivery',
      services: {
        async generateText() {
          generation += 1;
          if (generation === 1) return { text: '{"resolvedTask":"根据公司接待制度整理来访接待规则"}' };
          if (generation === 2) return { text: 'NEED_AGENTS\nunknown-agent: 直接发文件' };
          return { text: '<!doctype html><html><body><h1>来访接待规则</h1><p>依据制度证据整理完成。</p></body></html>' };
        },
        getToolDefinitions: () => [],
        async executeTool(name, args) {
          if (name !== 'publish_artifact') return `未知工具: ${name}`;
          published.push(String(args.relativePath));
          return `成果已发布到 ${String(args.relativePath)}`;
        },
        async createFileRecord(_projectId, relativePath) { published.push(`card:${relativePath}`); },
        async insertMessage() { return 'root-result-message'; },
        async sendDelegationMessage(input) {
          delegatedTargets.push(input.targetAgentInstanceId);
          return { messageId: `message-${input.targetAgentInstanceId}`, childRunIds: [`run-${input.targetAgentInstanceId}`] };
        },
        setRunStatus() {},
        setResultMessage() {},
        addRunEvent() {},
        getRunStatus: () => ({ status: 'completed', resultMessageId: 'km-result-message' }),
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
        async buildContextSnapshot() {
          return {
            snapshotChecksum: 'snapshot-knowledge-delivery',
            messages: [
              { role: 'user', content: '请根据公司接待制度整理来访接待规则' },
              { role: 'user', content: '发文件' },
            ],
          };
        },
        async writeContextManifest() {},
        getProjectRoot: () => 'C:/tmp/project-knowledge-delivery',
        renderSnapshotToText: () => '',
        getKmInstance: () => ({ id: 'knowledge-1', identityRelPath: null, profileEnabled: 1 }),
        getProjectDelegatableAgents: () => [
          { id: 'knowledge-1', name: '知识管理智能体', role: 'teammate', definitionId: 'builtin.knowledge-manager', runtimeMode: 'native-model', capabilities: '本地制度检索' },
        ],
        getMessageContent: () => '已检索公司接待制度，找到来访级别、陪同、食宿和车辆保障条款。',
        getLogger: () => ({ info() {}, warn() {}, error() {} }),
      },
    };

    await runOrchestrator(ctx);

    expect(delegatedTargets).toEqual(['knowledge-1']);
    expect(published.some((path) => path.endsWith('.html'))).toBe(true);
    expect(published.some((path) => path.startsWith('card:outputs/'))).toBe(true);
    // 统筹自行补齐成果后仍会再做一轮完成判断，然后才进入最终交付。
    expect(generation).toBeGreaterThanOrEqual(5);
    expect(generation).toBeLessThanOrEqual(6);
  });

  it('replans a failed work package with a bounded alternative delegation', async () => {
    const delegated: Array<{ target: string; instruction: string }> = [];
    let generation = 0;
    const agents = [
      { id: 'research-1', name: '资料调研智能体', role: 'teammate', definitionId: 'builtin.researcher', runtimeMode: 'native-model', capabilities: '公开资料调研' },
      { id: 'codebuddy-1', name: 'CodeBuddy', role: 'teammate', definitionId: 'custom.codebuddy', runtimeMode: 'external-cli', capabilities: 'HTML 文件成果生成' },
    ];
    const ctx: IGraphContext = {
      projectId: 'project-recovery',
      agentInstanceId: 'orchestrator-1',
      runId: 'root-recovery',
      instruction: '制作一份 HTML 行业分析报告',
      triggerMessageId: 'user-recovery',
      signal: new AbortController().signal,
      workspaceRoot: 'C:/tmp/project-recovery',
      services: {
        async generateText() {
          generation += 1;
          if (generation === 1) return { text: 'NEED_AGENTS\ncodebuddy-1: 生成行业分析 HTML 文件' };
          if (generation === 2) return { text: 'NEED_AGENTS\nresearch-1: 补充行业分析所需的公开来源和关键事实，并返回可核验摘要' };
          return { text: '行业分析已完成，已根据资料调研结果交付。' };
        },
        getToolDefinitions: () => [],
        async executeTool() { return ''; },
        async createFileRecord() {},
        async insertMessage() { return 'result-message'; },
        async sendDelegationMessage(input) {
          delegated.push({ target: input.targetAgentInstanceId, instruction: input.instruction });
          const sequence = delegated.length;
          return { messageId: `message-${input.targetAgentInstanceId}-${sequence}`, childRunIds: [`run-${input.targetAgentInstanceId}-${sequence}`] };
        },
        setRunStatus() {},
        setResultMessage() {},
        addRunEvent() {},
        getRunStatus(runId) {
          return runId === 'run-codebuddy-1-1'
            ? { status: 'failed', errorMessage: 'CodeBuddy 未能生成文件' }
            : { status: 'completed', resultMessageId: `${runId}-result` };
        },
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
        async buildContextSnapshot() { return { snapshotChecksum: 'snapshot-recovery', messages: [] }; },
        async writeContextManifest() {},
        getProjectRoot: () => 'C:/tmp/project-recovery',
        renderSnapshotToText: () => '',
        getKmInstance: () => undefined,
        getProjectDelegatableAgents: () => agents,
        getMessageContent: (messageId) => messageId.includes('codebuddy-1-3')
          ? '已根据调研证据完成文件，成果位于 outputs/industry-report.html。'
          : `资料调研已返回：${messageId}`,
        getLogger: () => ({ info() {}, warn() {}, error() {} }),
      },
    };

    await runOrchestrator(ctx);

    expect(delegated.map((item) => item.target)).toEqual(['codebuddy-1', 'research-1', 'codebuddy-1']);
    expect(delegated[1]?.instruction).toContain('公开来源');
    // 失败补救后仍未交付 HTML，统筹层会再次安排可用执行者补齐真实成果。
    expect(generation).toBe(5);
  });
});
