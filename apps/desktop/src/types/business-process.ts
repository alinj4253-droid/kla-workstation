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
