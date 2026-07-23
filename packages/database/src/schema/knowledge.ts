import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const knowledgeSources = sqliteTable('knowledge_sources', {
  id: text('id').primaryKey(),
  scopeType: text('scope_type', { enum: ['project', 'shared'] }).notNull(),
  scopeId: text('scope_id').notNull(),
  fileId: text('file_id').notNull(),
  versionId: text('version_id'),
  sha256: text('sha256'),
  status: text('status', { enum: ['pending', 'ingesting', 'ready', 'error'] }).notNull().default('pending'),
  ingestedAt: text('ingested_at'),
});

export const knowledgeIngestionJobs = sqliteTable('knowledge_ingestion_jobs', {
  id: text('id').primaryKey(),
  scopeType: text('scope_type', { enum: ['project', 'shared'] }).notNull(),
  scopeId: text('scope_id').notNull(),
  sourceId: text('source_id').notNull(),
  status: text('status', { enum: ['queued', 'running', 'completed', 'failed'] }).notNull().default('queued'),
  stage: text('stage'),
  progress: integer('progress'),
  errorCode: text('error_code'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_knowledge_jobs_scope').on(table.scopeType, table.scopeId, table.status),
]);

export const knowledgeChunks = sqliteTable('knowledge_chunks', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull(),
  ordinal: integer('ordinal').notNull(),
  text: text('text').notNull(),
  locationJson: text('location_json'),
  contentHash: text('content_hash').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  unq: uniqueIndex('unq_knowledge_chunks_source_ordinal').on(table.sourceId, table.ordinal),
}));

export const knowledgeNodes = sqliteTable('knowledge_nodes', {
  id: text('id').primaryKey(),
  scopeType: text('scope_type', { enum: ['project', 'shared'] }).notNull(),
  scopeId: text('scope_id').notNull(),
  nodeType: text('node_type').notNull(),
  canonicalName: text('canonical_name').notNull(),
  summary: text('summary'),
  propertiesJson: text('properties_json'),
  confidence: integer('confidence').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_knowledge_nodes_lookup').on(table.scopeType, table.scopeId, table.nodeType, table.canonicalName),
]);

export const knowledgeEdges = sqliteTable('knowledge_edges', {
  id: text('id').primaryKey(),
  scopeType: text('scope_type', { enum: ['project', 'shared'] }).notNull(),
  scopeId: text('scope_id').notNull(),
  sourceNodeId: text('source_node_id').notNull(),
  targetNodeId: text('target_node_id').notNull(),
  edgeType: text('edge_type').notNull(),
  propertiesJson: text('properties_json'),
  confidence: integer('confidence').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_knowledge_edges_lookup').on(table.scopeType, table.scopeId, table.sourceNodeId, table.targetNodeId, table.edgeType),
]);

export const knowledgePendingReview = sqliteTable('knowledge_pending_review', {
  id: text('id').primaryKey(),
  scopeType: text('scope_type', { enum: ['project', 'shared'] }).notNull(),
  scopeId: text('scope_id').notNull(),
  candidateType: text('candidate_type', { enum: ['entity', 'relationship'] }).notNull(),
  dataJson: text('data_json').notNull(),
  reason: text('reason', { enum: ['low_confidence', 'schema_mismatch', 'duplicate'] }).notNull(),
  status: text('status', { enum: ['pending', 'reviewed', 'dismissed'] }).notNull().default('pending'),
  reviewNote: text('review_note'),
  reviewedAt: text('reviewed_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_knowledge_pending_scope').on(table.scopeType, table.scopeId, table.status),
]);

export const knowledgeProvenance = sqliteTable('knowledge_provenance', {
  id: text('id').primaryKey(),
  targetType: text('target_type', { enum: ['node', 'edge', 'wiki'] }).notNull(),
  targetId: text('target_id').notNull(),
  sourceId: text('source_id'),
  chunkId: text('chunk_id'),
  locationJson: text('location_json'),
  quoteHash: text('quote_hash'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_knowledge_provenance_target').on(table.targetType, table.targetId),
  index('idx_knowledge_provenance_source').on(table.sourceId),
]);
