import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BaseRepository } from './base.js';

export interface KnowledgeSourceRow {
  id: string; scopeType: string; scopeId: string; fileId: string; versionId: string | null;
  sha256: string | null; contentMd5: string | null; parserId: string | null; metadataJson: string | null;
  status: string; ingestedAt: string | null;
}

export interface KnowledgeEmbeddingRow {
  chunkId: string; sourceId: string; modelId: string; dimensions: number; vectorJson: string; createdAt: string;
}

export interface KnowledgeJobRow {
  id: string; scopeType: string; scopeId: string; sourceId: string;
  status: string; stage: string | null; progress: number | null;
  errorCode: string | null; createdAt: string; updatedAt: string;
}

export interface KnowledgeChunkRow {
  id: string; sourceId: string; ordinal: number; text: string;
  locationJson: string | null; contentHash: string; createdAt: string;
}

export interface KnowledgeNodeRow {
  id: string; scopeType: string; scopeId: string; nodeType: string;
  canonicalName: string; summary: string | null; propertiesJson: string | null;
  confidence: number; createdAt: string; updatedAt: string;
}

export interface KnowledgeEdgeRow {
  id: string; scopeType: string; scopeId: string; sourceNodeId: string;
  targetNodeId: string; edgeType: string; propertiesJson: string | null;
  confidence: number; createdAt: string; updatedAt: string;
}

export interface KnowledgeProvenanceRow {
  id: string; targetType: string; targetId: string; sourceId: string | null;
  chunkId: string | null; locationJson: string | null; quoteHash: string | null; createdAt: string;
}

const S_COLS = 'id, scope_type as scopeType, scope_id as scopeId, file_id as fileId, version_id as versionId, sha256, content_md5 as contentMd5, parser_id as parserId, metadata_json as metadataJson, status, ingested_at as ingestedAt';
const J_COLS = 'id, scope_type as scopeType, scope_id as scopeId, source_id as sourceId, status, stage, progress, error_code as errorCode, created_at as createdAt, updated_at as updatedAt';
const C_COLS = 'id, source_id as sourceId, ordinal, text, location_json as locationJson, content_hash as contentHash, created_at as createdAt';
const N_COLS = 'id, scope_type as scopeType, scope_id as scopeId, node_type as nodeType, canonical_name as canonicalName, summary, properties_json as propertiesJson, confidence, created_at as createdAt, updated_at as updatedAt';
const E_COLS = 'id, scope_type as scopeType, scope_id as scopeId, source_node_id as sourceNodeId, target_node_id as targetNodeId, edge_type as edgeType, properties_json as propertiesJson, confidence, created_at as createdAt, updated_at as updatedAt';
const P_COLS = 'id, target_type as targetType, target_id as targetId, source_id as sourceId, chunk_id as chunkId, location_json as locationJson, quote_hash as quoteHash, created_at as createdAt';

export class KnowledgeRepository extends BaseRepository {
  constructor(db: Database.Database) { super(db); }

  // Sources
  listSources(scopeType: string, scopeId: string): KnowledgeSourceRow[] {
    return this.db.prepare(`SELECT ${S_COLS} FROM knowledge_sources WHERE scope_type = ? AND scope_id = ?`).all(scopeType, scopeId) as KnowledgeSourceRow[];
  }

  getSource(id: string): KnowledgeSourceRow | null {
    const row = this.db.prepare(`SELECT ${S_COLS} FROM knowledge_sources WHERE id = ?`).get(id) as KnowledgeSourceRow | undefined;
    return row ?? null;
  }

  getSourceByFile(fileId: string): KnowledgeSourceRow | null {
    const row = this.db.prepare(`SELECT ${S_COLS} FROM knowledge_sources WHERE file_id = ?`).get(fileId) as KnowledgeSourceRow | undefined;
    return row ?? null;
  }

  getSourceByFileAndVersion(fileId: string, versionId: string): KnowledgeSourceRow | null {
    const row = this.db.prepare(`SELECT ${S_COLS} FROM knowledge_sources WHERE file_id = ? AND version_id = ?`).get(fileId, versionId) as KnowledgeSourceRow | undefined;
    return row ?? null;
  }

  getSourceDetail(fileId: string): { source: KnowledgeSourceRow | null; job: KnowledgeJobRow | null; chunkCount: number; nodeCount: number } {
    const source = this.getSourceByFile(fileId);
    if (!source) return { source: null, job: null, chunkCount: 0, nodeCount: 0 };
    const jobs = this.db.prepare(
      `SELECT ${J_COLS} FROM knowledge_ingestion_jobs WHERE source_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).all(source.id) as KnowledgeJobRow[];
    const job = (jobs[0] as KnowledgeJobRow | undefined) ?? null;
    const chunkRow = this.db.prepare('SELECT COUNT(*) as c FROM knowledge_chunks WHERE source_id = ?').get(source.id) as { c: number };
    const nodeRow = this.db.prepare(
      'SELECT COUNT(DISTINCT target_id) as c FROM knowledge_provenance WHERE source_id = ? AND target_type = ?',
    ).get(source.id, 'node') as { c: number };
    return { source, job, chunkCount: chunkRow.c, nodeCount: nodeRow.c };
  }

  createSource(input: { scopeType: string; scopeId: string; fileId: string; versionId?: string; sha256?: string; contentMd5?: string }): KnowledgeSourceRow {
    const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    this.db.prepare(
      `INSERT INTO knowledge_sources (id, scope_type, scope_id, file_id, version_id, sha256, content_md5, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(id, input.scopeType, input.scopeId, input.fileId, input.versionId ?? null, input.sha256 ?? null, input.contentMd5 ?? null);
    return this.getSource(id)!;
  }

  setSourceStatus(id: string, status: 'pending' | 'ingesting' | 'ready' | 'error'): void {
    const ingested = status === 'ready' ? this.now() : null;
    this.db.prepare('UPDATE knowledge_sources SET status = ?, ingested_at = ? WHERE id = ?').run(status, ingested, id);
  }

  updateSourceMetadata(id: string, input: { contentMd5?: string; parserId?: string; metadataJson?: string }): void {
    this.db.prepare(
      `UPDATE knowledge_sources SET content_md5 = COALESCE(?, content_md5), parser_id = COALESCE(?, parser_id),
       metadata_json = COALESCE(?, metadata_json) WHERE id = ?`,
    ).run(input.contentMd5 ?? null, input.parserId ?? null, input.metadataJson ?? null, id);
  }

  // Jobs
  listJobs(scopeType?: string, scopeId?: string, status?: string): KnowledgeJobRow[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (scopeType) { clauses.push('scope_type = ?'); params.push(scopeType); }
    if (scopeId) { clauses.push('scope_id = ?'); params.push(scopeId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT ${J_COLS} FROM knowledge_ingestion_jobs ${where} ORDER BY created_at DESC`).all(...params) as KnowledgeJobRow[];
  }

  getJob(id: string): KnowledgeJobRow | null {
    const row = this.db.prepare(`SELECT ${J_COLS} FROM knowledge_ingestion_jobs WHERE id = ?`).get(id) as KnowledgeJobRow | undefined;
    return row ?? null;
  }

  getLatestJobForSource(sourceId: string): KnowledgeJobRow | null {
    const row = this.db.prepare(
      `SELECT ${J_COLS} FROM knowledge_ingestion_jobs WHERE source_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(sourceId) as KnowledgeJobRow | undefined;
    return row ?? null;
  }

  createJob(input: { scopeType: string; scopeId: string; sourceId: string }): KnowledgeJobRow {
    const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    const now = this.now();
    this.db.prepare(
      `INSERT INTO knowledge_ingestion_jobs (id, scope_type, scope_id, source_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(id, input.scopeType, input.scopeId, input.sourceId, now, now);
    return this.getJob(id)!;
  }

  setJobStatus(id: string, status: 'queued' | 'running' | 'completed' | 'failed', extra?: { stage?: string; progress?: number; errorCode?: string }): void {
    const now = this.now();
    const sets = ['status = ?', 'updated_at = ?'];
    const params: (string | number | null)[] = [status, now];
    if (extra?.stage !== undefined) { sets.push('stage = ?'); params.push(extra.stage); }
    if (extra?.progress !== undefined) { sets.push('progress = ?'); params.push(extra.progress); }
    if (extra?.errorCode !== undefined) { sets.push('error_code = ?'); params.push(extra.errorCode); }
    params.push(id);
    this.db.prepare(`UPDATE knowledge_ingestion_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  // Chunks
  listChunks(sourceId: string): KnowledgeChunkRow[] {
    return this.db.prepare(`SELECT ${C_COLS} FROM knowledge_chunks WHERE source_id = ? ORDER BY ordinal`).all(sourceId) as KnowledgeChunkRow[];
  }

  createChunk(input: { sourceId: string; ordinal: number; text: string; locationJson?: string; contentHash: string }): KnowledgeChunkRow {
    const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    const now = this.now();
    this.db.prepare(
      `INSERT INTO knowledge_chunks (id, source_id, ordinal, text, location_json, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.sourceId, input.ordinal, input.text, input.locationJson ?? null, input.contentHash, now);
    return this.getChunk(id)!;
  }

  getChunk(id: string): KnowledgeChunkRow | null {
    const row = this.db.prepare(`SELECT ${C_COLS} FROM knowledge_chunks WHERE id = ?`).get(id) as KnowledgeChunkRow | undefined;
    return row ?? null;
  }

  upsertDocumentProfile(input: {
    sourceId: string; summary: string; keywords: string[]; tags: string[]; language: string; metadataJson?: string;
  }): void {
    this.db.prepare(
      `INSERT INTO knowledge_document_profiles (source_id, summary, keywords_json, tags_json, language, metadata_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET summary = excluded.summary, keywords_json = excluded.keywords_json,
         tags_json = excluded.tags_json, language = excluded.language, metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
    ).run(input.sourceId, input.summary, JSON.stringify(input.keywords), JSON.stringify(input.tags), input.language, input.metadataJson ?? null, this.now());
  }

  upsertEmbedding(input: { chunkId: string; sourceId: string; modelId: string; vector: number[] }): void {
    this.db.prepare(
      `INSERT INTO knowledge_chunk_embeddings (chunk_id, source_id, model_id, dimensions, vector_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chunk_id) DO UPDATE SET source_id = excluded.source_id, model_id = excluded.model_id,
         dimensions = excluded.dimensions, vector_json = excluded.vector_json, created_at = excluded.created_at`,
    ).run(input.chunkId, input.sourceId, input.modelId, input.vector.length, JSON.stringify(input.vector), this.now());
  }

  listEmbeddings(scopes: Array<{ scopeType: string; scopeId: string }>): Array<KnowledgeEmbeddingRow & { text: string; fileName: string | null; locationJson: string | null }> {
    if (scopes.length === 0) return [];
    const where = scopes.map(() => '(s.scope_type = ? AND s.scope_id = ?)').join(' OR ');
    const params = scopes.flatMap((scope) => [scope.scopeType, scope.scopeId]);
    return this.db.prepare(
      `SELECT e.chunk_id as chunkId, e.source_id as sourceId, e.model_id as modelId, e.dimensions,
              e.vector_json as vectorJson, e.created_at as createdAt, c.text, c.location_json as locationJson, f.name as fileName
       FROM knowledge_chunk_embeddings e
       JOIN knowledge_chunks c ON c.id = e.chunk_id
       JOIN knowledge_sources s ON s.id = e.source_id
       LEFT JOIN files f ON f.id = s.file_id
       WHERE s.status = 'ready' AND (${where})`,
    ).all(...params) as Array<KnowledgeEmbeddingRow & { text: string; fileName: string | null; locationJson: string | null }>;
  }

  removeKnowledgeForFile(fileId: string): number {
    const sources = this.db.prepare('SELECT id FROM knowledge_sources WHERE file_id = ?').all(fileId) as Array<{ id: string }>;
    this.removeSources(sources.map((source) => source.id));
    return sources.length;
  }

  removeObsoleteSourcesForFile(fileId: string, keepSourceId: string): number {
    const sources = this.db.prepare('SELECT id FROM knowledge_sources WHERE file_id = ? AND id != ?').all(fileId, keepSourceId) as Array<{ id: string }>;
    this.removeSources(sources.map((source) => source.id));
    return sources.length;
  }

  private removeSources(sourceIds: string[]): void {
    if (sourceIds.length === 0) return;
    const placeholders = sourceIds.map(() => '?').join(',');
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM wiki_pages WHERE ${sourceIds.map(() => "source_refs_json LIKE '%' || ? || '%'").join(' OR ')}`).run(...sourceIds);
      this.db.prepare(`DELETE FROM knowledge_provenance WHERE source_id IN (${placeholders})`).run(...sourceIds);
      this.db.prepare(`DELETE FROM knowledge_chunk_embeddings WHERE source_id IN (${placeholders})`).run(...sourceIds);
      this.db.prepare(`DELETE FROM knowledge_document_profiles WHERE source_id IN (${placeholders})`).run(...sourceIds);
      this.db.prepare(`DELETE FROM knowledge_chunks WHERE source_id IN (${placeholders})`).run(...sourceIds);
      this.db.prepare(`DELETE FROM knowledge_ingestion_jobs WHERE source_id IN (${placeholders})`).run(...sourceIds);
      this.db.prepare(`DELETE FROM knowledge_sources WHERE id IN (${placeholders})`).run(...sourceIds);
      this.db.prepare('DELETE FROM knowledge_nodes WHERE id NOT IN (SELECT DISTINCT target_id FROM knowledge_provenance WHERE target_type = ?)').run('node');
      this.db.prepare('DELETE FROM knowledge_edges WHERE source_node_id NOT IN (SELECT id FROM knowledge_nodes) OR target_node_id NOT IN (SELECT id FROM knowledge_nodes)').run();
    })();
  }

  chunkExistsByHash(sourceId: string, contentHash: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM knowledge_chunks WHERE source_id = ? AND content_hash = ?').get(sourceId, contentHash);
    return !!row;
  }

  // Nodes
  listNodes(scopeType: string, scopeId: string, nodeType?: string): KnowledgeNodeRow[] {
    const clauses = ['scope_type = ?', 'scope_id = ?'];
    const params: string[] = [scopeType, scopeId];
    if (nodeType) { clauses.push('node_type = ?'); params.push(nodeType); }
    return this.db.prepare(`SELECT ${N_COLS} FROM knowledge_nodes WHERE ${clauses.join(' AND ')}`).all(...params) as KnowledgeNodeRow[];
  }

  getNode(id: string): KnowledgeNodeRow | null {
    const row = this.db.prepare(`SELECT ${N_COLS} FROM knowledge_nodes WHERE id = ?`).get(id) as KnowledgeNodeRow | undefined;
    return row ?? null;
  }

  upsertNode(input: { scopeType: string; scopeId: string; nodeType: string; canonicalName: string; summary?: string; propertiesJson?: string; confidence?: number }): KnowledgeNodeRow {
    const existing = this.db.prepare(
      'SELECT id FROM knowledge_nodes WHERE scope_type = ? AND scope_id = ? AND node_type = ? AND canonical_name = ?',
    ).get(input.scopeType, input.scopeId, input.nodeType, input.canonicalName) as { id: string } | undefined;
    const now = this.now();
    if (existing) {
      this.db.prepare('UPDATE knowledge_nodes SET summary = ?, properties_json = ?, confidence = ?, updated_at = ? WHERE id = ?')
        .run(input.summary ?? null, input.propertiesJson ?? null, input.confidence ?? 1, now, existing.id);
      return this.getNode(existing.id)!;
    }
    const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    this.db.prepare(
      `INSERT INTO knowledge_nodes (id, scope_type, scope_id, node_type, canonical_name, summary, properties_json, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.scopeType, input.scopeId, input.nodeType, input.canonicalName, input.summary ?? null, input.propertiesJson ?? null, input.confidence ?? 1, now, now);
    return this.getNode(id)!;
  }

  // Edges
  listEdges(scopeType: string, scopeId: string): KnowledgeEdgeRow[] {
    return this.db.prepare(`SELECT ${E_COLS} FROM knowledge_edges WHERE scope_type = ? AND scope_id = ?`).all(scopeType, scopeId) as KnowledgeEdgeRow[];
  }

  getEdge(id: string): KnowledgeEdgeRow | null {
    const row = this.db.prepare(`SELECT ${E_COLS} FROM knowledge_edges WHERE id = ?`).get(id) as KnowledgeEdgeRow | undefined;
    return row ?? null;
  }

  upsertEdge(input: { scopeType: string; scopeId: string; sourceNodeId: string; targetNodeId: string; edgeType: string; propertiesJson?: string; confidence?: number }): KnowledgeEdgeRow {
    const existing = this.db.prepare(
      'SELECT id FROM knowledge_edges WHERE scope_type = ? AND scope_id = ? AND source_node_id = ? AND target_node_id = ? AND edge_type = ?',
    ).get(input.scopeType, input.scopeId, input.sourceNodeId, input.targetNodeId, input.edgeType) as { id: string } | undefined;
    const now = this.now();
    if (existing) {
      this.db.prepare('UPDATE knowledge_edges SET properties_json = ?, confidence = ?, updated_at = ? WHERE id = ?')
        .run(input.propertiesJson ?? null, input.confidence ?? 1, now, existing.id);
      return this.getEdge(existing.id)!;
    }
    const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    this.db.prepare(
      `INSERT INTO knowledge_edges (id, scope_type, scope_id, source_node_id, target_node_id, edge_type, properties_json, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.scopeType, input.scopeId, input.sourceNodeId, input.targetNodeId, input.edgeType, input.propertiesJson ?? null, input.confidence ?? 1, now, now);
    return this.getEdge(id)!;
  }

  // Provenance
  listProvenance(targetType: string, targetId: string): KnowledgeProvenanceRow[] {
    return this.db.prepare(`SELECT ${P_COLS} FROM knowledge_provenance WHERE target_type = ? AND target_id = ?`).all(targetType, targetId) as KnowledgeProvenanceRow[];
  }

  createProvenance(input: { targetType: string; targetId: string; sourceId?: string; chunkId?: string; locationJson?: string; quoteHash?: string }): KnowledgeProvenanceRow {
    const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    const now = this.now();
    this.db.prepare(
      `INSERT INTO knowledge_provenance (id, target_type, target_id, source_id, chunk_id, location_json, quote_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.targetType, input.targetId, input.sourceId ?? null, input.chunkId ?? null, input.locationJson ?? null, input.quoteHash ?? null, now);
    return this.listProvenance(input.targetType, input.targetId).pop()!;
  }

  removeProvenance(targetType: string, targetId: string): void {
    this.db.prepare('DELETE FROM knowledge_provenance WHERE target_type = ? AND target_id = ?').run(targetType, targetId);
  }

  // Provenance detail with source file and chunk text
  listProvenanceDetail(targetType: string, targetId: string): Array<{
    sourceId: string; chunkId: string | null;
    locationJson: string | null; quoteHash: string | null;
    sourceFileName: string | null; chunkTextPreview: string | null;
  }> {
    const rows = this.db.prepare(`
      SELECT p.source_id as sourceId, p.chunk_id as chunkId,
             p.location_json as locationJson, p.quote_hash as quoteHash,
             f.name as sourceFileName,
             c.text as chunkTextPreview
      FROM knowledge_provenance p
      LEFT JOIN knowledge_sources s ON p.source_id = s.id
      LEFT JOIN files f ON s.file_id = f.id
      LEFT JOIN knowledge_chunks c ON p.chunk_id = c.id
      WHERE p.target_type = ? AND p.target_id = ?
    `).all(targetType, targetId) as Array<{
      sourceId: string; chunkId: string | null;
      locationJson: string | null; quoteHash: string | null;
      sourceFileName: string | null; chunkTextPreview: string | null;
    }>;
    return rows.map((r) => ({
      ...r,
      chunkTextPreview: r.chunkTextPreview ? r.chunkTextPreview.slice(0, 200) + (r.chunkTextPreview.length > 200 ? '…' : '') : null,
    }));
  }

  // Graph query (full graph for a scope)
  getGraph(scopeType: string, scopeId: string): { nodes: KnowledgeNodeRow[]; edges: KnowledgeEdgeRow[]; constraints?: string } {
    const nodeLimit = 2000;
    const nodes = this.db.prepare(
      `SELECT ${N_COLS} FROM knowledge_nodes WHERE scope_type = ? AND scope_id = ? LIMIT ?`,
    ).all(scopeType, scopeId, nodeLimit + 1) as KnowledgeNodeRow[];
    const truncated = nodes.length > nodeLimit;
    if (truncated) nodes.pop();
    const nodeIds = nodes.map((n) => n.id);
    const edges = nodeIds.length > 0
      ? this.db.prepare(`SELECT ${E_COLS} FROM knowledge_edges WHERE scope_type = ? AND scope_id = ? AND (source_node_id IN (${nodeIds.map(() => '?').join(',')}) OR target_node_id IN (${nodeIds.map(() => '?').join(',')}))`)
        .all(scopeType, scopeId, ...nodeIds, ...nodeIds) as KnowledgeEdgeRow[]
      : [];
    const result: { nodes: KnowledgeNodeRow[]; edges: KnowledgeEdgeRow[]; constraints?: string } = { nodes, edges };
    if (truncated) result.constraints = `图谱节点超过 ${nodeLimit} 个，仅展示前 ${nodeLimit} 个`;
    return result;
  }

  // ── Pending Review（低置信度候选） ──
  listPendingReview(scopeType: string, scopeId: string, status?: string): Array<{
    id: string; candidateType: string; dataJson: string; reason: string;
    status: string; reviewNote: string | null; createdAt: string; reviewedAt: string | null;
  }> {
    if (status) {
      return this.db.prepare(
        `SELECT id, candidate_type as candidateType, data_json as dataJson, reason,
                status, review_note as reviewNote, created_at as createdAt, reviewed_at as reviewedAt
         FROM knowledge_pending_review WHERE scope_type = ? AND scope_id = ? AND status = ? ORDER BY created_at DESC`,
      ).all(scopeType, scopeId, status) as any[];
    }
    return this.db.prepare(
      `SELECT id, candidate_type as candidateType, data_json as dataJson, reason,
              status, review_note as reviewNote, created_at as createdAt, reviewed_at as reviewedAt
       FROM knowledge_pending_review WHERE scope_type = ? AND scope_id = ? ORDER BY created_at DESC`,
    ).all(scopeType, scopeId) as any[];
  }

  addPendingReview(input: {
    scopeType: string; scopeId: string; candidateType: string;
    dataJson: string; reason: string;
  }): void {
    const id = randomUUID().toLowerCase().replace(/-/g, '').slice(0, 24);
    const now = this.now();
    this.db.prepare(
      `INSERT INTO knowledge_pending_review (id, scope_type, scope_id, candidate_type, data_json, reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(id, input.scopeType, input.scopeId, input.candidateType, input.dataJson, input.reason, now);
  }

  resolvePendingReview(id: string, status: 'reviewed' | 'dismissed', reviewNote?: string): void {
    const now = this.now();
    this.db.prepare(
      `UPDATE knowledge_pending_review SET status = ?, review_note = ?, reviewed_at = ? WHERE id = ?`,
    ).run(status, reviewNote ?? null, now, id);
  }

  // Search across knowledge
  search(query: string, scopeType?: string, scopeId?: string, limit = 50): { nodes: KnowledgeNodeRow[]; chunks: KnowledgeChunkRow[] } {
    const like = `%${query.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    const params: unknown[] = [like];
    let scopeClause = '';
    if (scopeType && scopeId) { scopeClause = 'AND scope_type = ? AND scope_id = ?'; params.push(scopeType, scopeId); }
    const nodes = this.db.prepare(
      `SELECT ${N_COLS} FROM knowledge_nodes WHERE (canonical_name LIKE ? OR summary LIKE ?) ${scopeClause} LIMIT ?`,
    ).all(...params, like, limit) as KnowledgeNodeRow[];
    const chunks = scopeType && scopeId
      ? this.db.prepare(
        `SELECT ${C_COLS.replaceAll('source_id', 'c.source_id').replaceAll('id,', 'c.id,')} FROM knowledge_chunks c
         JOIN knowledge_sources s ON s.id = c.source_id
         WHERE c.text LIKE ? AND s.scope_type = ? AND s.scope_id = ? AND s.status = 'ready' LIMIT ?`,
      ).all(like, scopeType, scopeId, limit) as KnowledgeChunkRow[]
      : this.db.prepare(`SELECT ${C_COLS} FROM knowledge_chunks WHERE text LIKE ? LIMIT ?`).all(like, limit) as KnowledgeChunkRow[];
    return { nodes, chunks };
  }
}
