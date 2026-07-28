export type MemoryScope = 'short-term' | 'long-term';

export type MemoryStatus = 'active' | 'expired' | 'deleted';

export interface MemoryRecord {
  id: string;
  projectId: string;
  agentInstanceId: string;
  scope: MemoryScope;
  type: string;
  content: string;
  confidence: number;
  sourceRefsJson: string | null;
  status: MemoryStatus;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMemoryInput {
  projectId: string;
  agentInstanceId: string;
  scope: MemoryScope;
  type: string;
  content: string;
  confidence?: number;
  sourceRefsJson?: string;
  expiresAt?: string;
}

export interface UpdateMemoryInput {
  content?: string;
  confidence?: number;
  status?: MemoryStatus;
}
