export type MemoryScope = 'short-term' | 'long-term';

export type MemoryStatus = 'active' | 'expired' | 'deleted' | 'consolidated' | 'superseded';

export interface MemoryRecord {
  id: string;
  projectId: string;
  agentInstanceId: string;
  scope: MemoryScope;
  type: string;
  content: string;
  confidence: number;
  importance: number;
  pinned: boolean;
  topicKey: string | null;
  sourceRefsJson: string | null;
  metadataJson: string | null;
  status: MemoryStatus;
  expiresAt: string | null;
  lastReinforcedAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
  consolidatedIntoId: string | null;
  supersedesId: string | null;
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
  importance?: number;
  pinned?: boolean;
  topicKey?: string;
  sourceRefsJson?: string;
  metadataJson?: string;
  expiresAt?: string;
  lastReinforcedAt?: string;
  consolidatedIntoId?: string;
  supersedesId?: string;
}

export interface UpdateMemoryInput {
  content?: string;
  confidence?: number;
  importance?: number;
  pinned?: boolean;
  topicKey?: string | null;
  sourceRefsJson?: string | null;
  metadataJson?: string | null;
  status?: MemoryStatus;
  expiresAt?: string | null;
  lastReinforcedAt?: string;
  lastAccessedAt?: string | null;
  accessCount?: number;
  consolidatedIntoId?: string | null;
  supersedesId?: string | null;
}

export interface MemoryRecallOptions {
  now?: Date;
  limit?: number;
  minimumScore?: number;
  shortTermHalfLifeHours?: number;
  longTermHalfLifeHours?: number;
}

export interface RankedMemory {
  record: MemoryRecord;
  score: number;
  semanticScore: number;
  timeScore: number;
}
