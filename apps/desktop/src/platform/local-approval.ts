export type LocalApprovalRequest = {
  id: string;
  action: string;
  tool: string;
  runId: string;
  execution: string;
  details: Array<{ label: string; value: string; code: boolean }>;
};
export type LocalApprovalBridge = {
  pending(): Promise<LocalApprovalRequest | null>;
  decide(decision: { id: string; approved: boolean }): Promise<{ accepted: boolean }>;
  onChange(listener: (request: LocalApprovalRequest | null) => void): () => void;
};
