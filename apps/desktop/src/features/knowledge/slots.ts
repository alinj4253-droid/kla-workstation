import type { ReactNode } from 'react';
import type { ChunkCountReport, KnowledgeContext, KnowledgeSource, KnowledgeSlice, RemoteDocument, SourceRef, SourceJobBinding, JobSnapshot } from '@kla-workstation/contracts/knowledge';

export interface KnowledgeSlots {
  chunksPanel?: (props: { context: KnowledgeContext; sources: RemoteDocument[]; sourceMappings: readonly KnowledgeSource[]; sourceVersion: string; onChunkCount: (report: ChunkCountReport) => void; onOpenDocument: (source: SourceRef) => void; onOpenSlice: (selection: { slice: KnowledgeSlice; source: KnowledgeSource }) => void }) => ReactNode;
  documentPanel?: (props: { source: SourceRef; context: KnowledgeContext; sources: readonly KnowledgeSource[]; sliceIndex?: number; onClose: () => void }) => ReactNode;
  searchPanel?: (props: { context: KnowledgeContext; sources: readonly KnowledgeSource[]; sourceVersion: string; onOpenDocument: (source: SourceRef, sliceIndex?: number) => void; onClose: () => void }) => ReactNode;
  slicePanel?: (props: { slice: KnowledgeSlice; source: KnowledgeSource; onOpenDocument: (source: SourceRef, sliceIndex?: number) => void; onSaveSlice?: (input: { sliceId: number; title: string; content: string }) => Promise<void> }) => ReactNode;
  sourceChanged?: (binding: SourceJobBinding, snapshot: JobSnapshot) => void;
}
