import type { ModelSlot, ModelMessage, GenerateOptions, GenerateResult } from '@kunqing/model-core';

export type AgentRole = 'orchestrator' | 'knowledge-manager' | 'external-cli';

export interface DelegatableAgentInfo {
  id: string;
  name: string;
  role: string;
  definitionId: string;
  runtimeMode: string;
}

export type BusinessProcessActionType =
  | 'research'
  | 'acquire'
  | 'calculate'
  | 'analyze'
  | 'synthesize'
  | 'validate'
  | 'deliver'
  | 'other';

export type BusinessProcessStep = {
  id: string;
  title: string;
  actionType: BusinessProcessActionType;
  description?: string;
  inputs?: string[];
  outputs?: string[];
  owner?: string;
};

export type BusinessProcessStage = {
  id: string;
  title: string;
  objective?: string;
  owner?: string;
  steps: BusinessProcessStep[];
};

export type BusinessProcess = {
  schemaVersion: 1;
  applicable: boolean;
  reason?: string;
  title: string;
  summary?: string;
  generatedByAgentId: string;
  generatedByAgentName: string;
  generatedAt: string;
  knowledgeDocumentPath?: string;
  stages: BusinessProcessStage[];
};

export interface CLIDelegation {
  agentInstanceId: string;
  agentName: string;
  subRunId: string;
  instruction: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ExecContextSnapshot {
  snapshotChecksum: string;
  messages: ModelMessage[];
}

export interface SubRunParams {
  runId: string;
  projectId: string;
  agentInstanceId: string;
  instruction: string;
  triggerMessageId: string;
  modelProfileSnapshotJson: string | null;
}

export interface CreateSubRunInput {
  projectId: string;
  agentInstanceId: string;
  instruction: string;
  requestedByType: string;
  requestedById: string;
  parentRunId: string;
  modelProfileSnapshotJson: string | null;
}

export interface KmInstanceInfo {
  id: string;
  identityRelPath: string | null;
  profileEnabled: number;
}

export interface IGraphContext {
  projectId: string;
  agentInstanceId: string;
  runId: string;
  instruction: string;
  triggerMessageId: string;
  signal: AbortSignal;
  workspaceRoot: string;

  services: {
    generateText(slot: ModelSlot, messages: ModelMessage[], options?: GenerateOptions): Promise<GenerateResult>;

    getToolDefinitions(role: AgentRole): ToolDefinition[];

    executeTool(name: string, args: Record<string, unknown>, role: AgentRole, context: { runId?: string; projectId?: string }): Promise<string>;

    createFileRecord(projectId: string, relativePath: string, content: string, agentInstanceId: string, runId: string, note?: string): Promise<void>;

    insertMessage(projectId: string, senderId: string, kind: string, contentJson: string): Promise<string>;

    sendDelegationMessage(input: {
      projectId: string;
      senderId: string;
      parentRunId: string;
      rootTriggerMessageId: string;
      targetAgentInstanceId: string;
      targetAgentName: string;
      instruction: string;
      visibleInstruction?: string;
    }): Promise<{ messageId: string; childRunIds: string[] }>;

    setRunStatus(runId: string, status: string, error?: { errorCode?: string; errorMessage?: string }): void;

    setResultMessage(runId: string, messageId: string): void;

    addRunEvent(runId: string, type: string, payload: Record<string, unknown>): void;

    getRunStatus(runId: string): { status: string; resultMessageId?: string; errorMessage?: string };

    getParentRunId(runId: string): string | null;

    getRunAgentInstanceId(runId: string): string | null;

    getAgentDisplayName(agentInstanceId: string): string | null;

    createSubRun(input: CreateSubRunInput): string;

    enqueueRun(params: SubRunParams): void;

    emitEvent(event: Record<string, unknown>): void;

    storeMemory(projectId: string, agentInstanceId: string, type: string, content: string, confidence?: number): void;

    consolidateMemory(projectId: string, agentInstanceId: string): number;

    extractLongTermMemory(projectId: string, agentInstanceId: string): number;

    buildMemoryContext(projectId: string, agentInstanceId: string): string;

    buildContextSnapshot(projectId: string, agentInstanceId: string, triggerMessageId: string): Promise<ExecContextSnapshot>;

    writeContextManifest(snapshot: ExecContextSnapshot, projectRoot: string): Promise<void>;

    getProjectRoot(projectId: string): string;

    renderSnapshotToText(snapshot: ExecContextSnapshot): string;

    getKmInstance(projectId: string): KmInstanceInfo | undefined;

    getProjectDelegatableAgents(projectId: string): DelegatableAgentInfo[];

    getMessageContent(messageId: string): string | null;

    getLogger(): { info: (msg: string, ...args: unknown[]) => void; warn: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void };
  };
}

export interface FileRecordResult {
  id: string;
  normalizedPath: string;
}

export interface OrchestratorGraphState {
  projectId: string;
  agentInstanceId: string;
  runId: string;
  instruction: string;
  triggerMessageId: string;
  messages: ModelMessage[];
  subAgentResult: string;
  finalResponse: string;
  needsKnowledgeManager: boolean;
  needsCLIDelegation: boolean;
  cliDelegations: CLIDelegation[];
  knowledgeCurated: boolean;
  artifacts: Array<{ relativePath: string; content: string }>;
}

export interface KMGraphState {
  projectId: string;
  agentInstanceId: string;
  runId: string;
  instruction: string;
  triggerMessageId: string;
  sourceFileId: string;
  sourceFilePath: string;
  sourceId: string;
  scopeType: string;
  scopeId: string;
  parsedText: string;
  mimeType: string;
  chunks: unknown[];
  extractedGraph: unknown | null;
  validatedEntities: unknown[];
  validatedRelationships: unknown[];
  wikiPages: unknown[];
  visualizationProjection: string;
  pipelineCompleted: boolean;
  entityCount: number;
  relationshipCount: number;
  wikiPageCount: number;
  error: string;
  report: string;
}
