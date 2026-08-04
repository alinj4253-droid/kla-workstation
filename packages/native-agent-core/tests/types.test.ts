import { describe, expect, it } from 'vitest';
import type { IGraphContext, OrchestratorGraphState, AgentRole, ExecContextSnapshot, CreateSubRunInput, SubRunParams, ToolDefinition } from '../src/types';

describe('IGraphContext interface', () => {
  it('can be implemented with all required properties', () => {
    const createMockCtx = (): IGraphContext => ({
      projectId: 'proj-1',
      agentInstanceId: 'agent-1',
      runId: 'run-1',
      instruction: 'Test instruction',
      triggerMessageId: 'msg-1',
      signal: new AbortController().signal,
      workspaceRoot: '/tmp/workspace',
      services: {
        generateText(_slot, _messages, _options?) {
          return Promise.resolve({ text: 'response', toolCalls: [] });
        },
        getToolDefinitions(_role) {
          return [];
        },
        executeTool(_name, _args, _role, _context) {
          return Promise.resolve('tool result');
        },
        createFileRecord(_projectId, _relativePath, _content, _agentInstanceId, _runId, _note?) {
          return Promise.resolve();
        },
        insertMessage(_projectId, _senderId, _kind, _contentJson) {
          return Promise.resolve('msg-id');
        },
        sendDelegationMessage() { return Promise.resolve({ messageId: 'delegation-msg', childRunIds: ['sub-run-id'] }); },
        setRunStatus(_runId, _status, _error?) {},
        setResultMessage(_runId, _messageId) {},
        addRunEvent(_runId, _type, _payload) {},
        getRunStatus(_runId) {
          return { status: 'completed', resultMessageId: 'msg-1' };
        },
        getParentRunId(_runId) {
          return null;
        },
        getRunAgentInstanceId(_runId) {
          return null;
        },
        getAgentDisplayName() { return null; },
        createSubRun(_input) {
          return 'sub-run-id';
        },
        enqueueRun(_params) {},
        emitEvent(_event) {},
        storeMemory(_projectId, _agentInstanceId, _type, _content, _confidence?) {},
        consolidateMemory(_projectId, _agentInstanceId) {
          return 0;
        },
        extractLongTermMemory(_projectId, _agentInstanceId) {
          return 0;
        },
        buildMemoryContext(_projectId, _agentInstanceId) {
          return '';
        },
        buildContextSnapshot(_projectId, _agentInstanceId, _triggerMessageId) {
          return Promise.resolve({ snapshotChecksum: 'abc123', messages: [] });
        },
        writeContextManifest(_snapshot, _projectRoot) {
          return Promise.resolve();
        },
        getProjectRoot(_projectId) {
          return '/tmp/project';
        },
        renderSnapshotToText(_snapshot) {
          return 'rendered context';
        },
        getKmInstance(_projectId) {
          return null;
        },
        getMessageContent(_messageId) {
          return 'message content';
        },
        getLogger() {
          return { info: () => {}, warn: () => {}, error: () => {} };
        },
      },
    });

    const ctx = createMockCtx();
    expect(ctx.projectId).toBe('proj-1');
    expect(ctx.runId).toBe('run-1');
    expect(ctx.services).toBeDefined();
  });

  it('services.generateText returns result with toolCalls', async () => {
    const ctx: IGraphContext = {
      projectId: 'proj-1',
      agentInstanceId: 'agent-1',
      runId: 'run-1',
      instruction: 'test',
      triggerMessageId: 'msg-1',
      signal: new AbortController().signal,
      workspaceRoot: '/tmp',
      services: {
        generateText() { return Promise.resolve({ text: 'response', toolCalls: [{ name: 'test', args: { x: 1 } }] }); },
        getToolDefinitions() { return []; },
        executeTool() { return Promise.resolve('ok'); },
        createFileRecord() { return Promise.resolve(); },
        insertMessage() { return Promise.resolve('msg-id'); },
        sendDelegationMessage() { return Promise.resolve({ messageId: 'delegation-msg', childRunIds: ['sub-id'] }); },
        setRunStatus() {},
        setResultMessage() {},
        addRunEvent() {},
        getRunStatus() { return { status: 'completed' }; },
        getParentRunId() { return null; },
        getRunAgentInstanceId() { return null; },
        getAgentDisplayName() { return null; },
        createSubRun() { return 'sub-id'; },
        enqueueRun() {},
        emitEvent() {},
        storeMemory() {},
        consolidateMemory() { return 0; },
        extractLongTermMemory() { return 0; },
        buildMemoryContext() { return ''; },
        buildContextSnapshot() { return Promise.resolve({ snapshotChecksum: 'abc', messages: [] }); },
        writeContextManifest() { return Promise.resolve(); },
        getProjectRoot() { return '/tmp'; },
        renderSnapshotToText() { return ''; },
        getKmInstance() { return null; },
        getMessageContent() { return null; },
        getLogger() { return { info() {}, warn() {}, error() {} }; },
      },
    };

    const result = await ctx.services.generateText('reasoning', [{ role: 'user', content: 'Hi' }]);
    expect(result.text).toBe('response');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.name).toBe('test');
  });
});

describe('OrchestratorGraphState type', () => {
  it('accepts a complete state object', () => {
    const state: OrchestratorGraphState = {
      projectId: 'proj-1',
      agentInstanceId: 'agent-1',
      runId: 'run-1',
      instruction: 'do something',
      triggerMessageId: 'msg-1',
      messages: [{ role: 'assistant', content: 'hello' }],
      subAgentResult: 'sub result',
      finalResponse: 'final response',
      needsKnowledgeManager: false,
      artifacts: [{ relativePath: 'output.md', content: '# Output' }],
    };
    expect(state.messages).toHaveLength(1);
    expect(state.artifacts).toHaveLength(1);
    expect(state.finalResponse).toBe('final response');
  });

  it('accepts minimal state with defaults', () => {
    const state: OrchestratorGraphState = {
      projectId: 'proj-1',
      agentInstanceId: 'agent-1',
      runId: 'run-1',
      instruction: 'test',
      triggerMessageId: 'msg-1',
      messages: [],
      subAgentResult: '',
      finalResponse: '',
      needsKnowledgeManager: false,
      artifacts: [],
    };
    expect(state.messages).toEqual([]);
    expect(state.needsKnowledgeManager).toBe(false);
  });
});

describe('AgentRole type', () => {
  it('accepts orchestrator role', () => {
    const role: AgentRole = 'orchestrator';
    expect(role).toBe('orchestrator');
  });

  it('accepts knowledge-manager role', () => {
    const role: AgentRole = 'knowledge-manager';
    expect(role).toBe('knowledge-manager');
  });

  it('accepts researcher role', () => {
    const role: AgentRole = 'researcher';
    expect(role).toBe('researcher');
  });
});

describe('ToolDefinition type', () => {
  it('accepts a complete tool definition', () => {
    const def: ToolDefinition = {
      name: 'get_weather',
      description: 'Get weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name' } },
        required: ['city'],
      },
    };
    expect(def.name).toBe('get_weather');
    expect(def.required).toBeUndefined();
  });
});

describe('ExecContextSnapshot type', () => {
  it('accepts snapshot with messages', () => {
    const snapshot: ExecContextSnapshot = {
      snapshotChecksum: 'abc123',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ],
    };
    expect(snapshot.messages).toHaveLength(2);
  });
});

describe('CreateSubRunInput type', () => {
  it('accepts sub run input', () => {
    const input: CreateSubRunInput = {
      projectId: 'proj-1',
      agentInstanceId: 'agent-1',
      instruction: 'sub task',
      requestedByType: 'agent',
      requestedById: 'parent-agent',
      parentRunId: 'run-1',
      modelProfileSnapshotJson: null,
    };
    expect(input.instruction).toBe('sub task');
  });
});

describe('SubRunParams type', () => {
  it('accepts sub run params', () => {
    const params: SubRunParams = {
      runId: 'sub-run-1',
      projectId: 'proj-1',
      agentInstanceId: 'agent-1',
      instruction: 'sub task',
      triggerMessageId: 'msg-1',
    };
    expect(params.runId).toBe('sub-run-1');
  });
});
