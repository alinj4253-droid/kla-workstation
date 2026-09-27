import type { ModelSlot, ModelMessage, GenerateOptions, GenerateResult } from '@kunqing/model-core';

export type AgentRole = 'orchestrator' | 'knowledge-manager' | 'external-cli';
export type CollaborationMode = 'fast' | 'balanced' | 'expert';

export interface DelegatableAgentInfo {
  id: string;
  name: string;
  role: string;
  definitionId: string;
  runtimeMode: string;
  capabilities?: string;
  /** Public, non-memory role information available to the team leader for dispatch. */
  coordinationProfile?: string;
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
  messages: Array<ModelMessage & {
    id?: string;
    senderName?: string;
    taskRelation?: 'current' | 'chain' | 'history';
  }>;
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
  /** Defaults to expert for older callers and channel messages. */
  collaborationMode?: CollaborationMode;
  /** Some groups require the orchestrator to route every concrete task to a member. */
  delegationOnly?: boolean;

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

    /** 群聊协调说明（例如复杂需求的子需求清单）：仅落库展示，不触发成员 Run。 */
    sendOrchestratorNote?(input: {
      runId: string;
      projectId: string;
      senderId: string;
      rootTriggerMessageId: string;
      text: string;
    }): Promise<string>;

    setRunStatus(runId: string, status: string, error?: { errorCode?: string; errorMessage?: string }): void;

    setResultMessage(runId: string, messageId: string): void;

    addRunEvent(runId: string, type: string, payload: Record<string, unknown>): void;

    /** Optional event reader used to carry compact, user-visible task summaries
     * between planner rounds without re-injecting the full chat history. */
    getRunEvents?(runId: string): Array<{ type: string; payload?: Record<string, unknown> }>;

    getRunStatus(runId: string): { status: string; resultMessageId?: string; errorMessage?: string };

    /** Returns every nested handoff below a Run so the leader can wait for the whole branch. */
    getRunDescendants?(runId: string): Array<{
      runId: string;
      agentInstanceId: string;
      status: string;
      resultMessageId?: string;
      errorMessage?: string;
    }>;

    getRunArtifacts?(runId: string, recursive?: boolean): Array<{
      relativePath: string;
      fileId?: string;
      versionId?: string;
      messageId?: string;
      sha256?: string;
    }>;

    getParentRunId(runId: string): string | null;

    getRunAgentInstanceId(runId: string): string | null;

    getAgentDisplayName(agentInstanceId: string): string | null;

    createSubRun(input: CreateSubRunInput): string;

    enqueueRun(params: SubRunParams): void;

    emitEvent(event: Record<string, unknown>): void;

    storeMemory(projectId: string, agentInstanceId: string, type: string, content: string, confidence?: number): void;

    consolidateMemory(projectId: string, agentInstanceId: string): number;

    extractLongTermMemory(projectId: string, agentInstanceId: string): number;

    buildMemoryContext(projectId: string, agentInstanceId: string, query?: string): string;

    buildContextSnapshot(projectId: string, agentInstanceId: string, triggerMessageId: string): Promise<ExecContextSnapshot>;

    writeContextManifest(snapshot: ExecContextSnapshot, projectRoot: string): Promise<void>;

    getProjectRoot(projectId: string): string;

    renderSnapshotToText(snapshot: ExecContextSnapshot): string;

    getKmInstance(projectId: string): KmInstanceInfo | undefined;

    getProjectDelegatableAgents(projectId: string): DelegatableAgentInfo[];

    /** Persist the business-level TODO/DAG. agent_runs remains the low-level execution log. */
    saveTaskPlan?(input: {
      projectId: string;
      rootRunId: string;
      triggerMessageId: string;
      resolvedGoal: string;
      complexity: 'simple' | 'complex' | 'missing-input';
      status?: 'planned' | 'running' | 'waiting-user' | 'completed' | 'failed' | 'cancelled';
      completionCriteria: string[];
      nodes: Array<{
        id: string;
        title: string;
        objective: string;
        inputs?: string[];
        expectedResult?: string;
        completionCriteria: string[];
        dependsOn: string[];
        executionMode?: 'serial' | 'parallel' | 'wait-user';
        assignedAgentId?: string;
        status?: 'pending' | 'ready' | 'assigned' | 'running' | 'waiting-user' | 'completed' | 'failed' | 'blocked' | 'cancelled';
      }>;
    }): string;

    updateTaskNode?(rootRunId: string, nodeId: string, patch: {
      status: 'pending' | 'ready' | 'assigned' | 'running' | 'waiting-user' | 'completed' | 'failed' | 'blocked' | 'cancelled';
      assignedAgentId?: string;
      resultMessageId?: string;
      artifacts?: unknown[];
    }): void;

    setTaskPlanStatus?(rootRunId: string, status: 'planned' | 'running' | 'waiting-user' | 'completed' | 'failed' | 'cancelled'): void;

    getMessageContent(messageId: string): string | null;

    getLogger(): { info: (msg: string, ...args: unknown[]) => void; warn: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void };
  };
}

export interface FileRecordResult {
  id: string;
  normalizedPath: string;
}

export interface OrchestratorMacroStage {
  id: string;
  objective: string;
  completionCriteria: string[];
  dependsOn: string[];
  status: 'pending' | 'active' | 'satisfied' | 'blocked';
}

export interface OrchestratorMacroPlan {
  goal: string;
  completionCriteria: string[];
  stages: OrchestratorMacroStage[];
}

export interface OrchestratorGraphState {
  projectId: string;
  agentInstanceId: string;
  runId: string;
  instruction: string;
  resolvedTask?: string;
  triggerMessageId: string;
  messages: ModelMessage[];
  subAgentResult: string;
  finalResponse: string;
  needsKnowledgeManager: boolean;
  needsCLIDelegation: boolean;
  /** True only when the current delegation batch was explicitly declared independent. */
  parallelDelegationApproved?: boolean;
  /**
   * True only when a single direct-planner delegation can fully close the loop:
   * the member's own reply is the final answer, so the orchestrator ends right
   * after delegating instead of waiting and summarizing.
   */
  fireAndForgetDelegation?: boolean;
  /** Work the root orchestrator must perform itself before replanning. */
  selfInstruction?: string;
  cliDelegations: CLIDelegation[];
  recoveryCount: number;
  /** Signatures of decisions already attempted in the adaptive planner loop. */
  plannerHistory?: string[];
  /** Planner-provided natural chat text for each planned delegation target. */
  delegationNotes?: Array<{ agentInstanceId: string; visibleMessage: string }>;
  /** Stable high-level plan; only the active stage is replanned tactically. */
  macroPlan?: OrchestratorMacroPlan | null;
  activeStageId?: string;
  stageAttempts?: Record<string, number>;
  awaitingUser?: { question: string; missingFields: string[] } | null;
  materializationPass?: number;
  reviewAttempted?: boolean;
  reviewPass?: boolean;
  reviewFindings?: string;
  draftArtifactPath?: string;
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
