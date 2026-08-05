import type Database from 'better-sqlite3';
import { KnowledgeRepository } from '@kunqing/database';
import { cosineSimilarity, embedTextLocally } from '@kunqing/knowledge-core';
import { isBuiltinToolEnabled } from './builtin-tool-catalog';

export type RetrievalChannel = 'keyword' | 'vector' | 'graph' | 'wiki';

export type HybridKnowledgeHit = {
  id: string;
  kind: 'chunk' | 'entity' | 'wiki';
  title: string;
  excerpt: string;
  score: number;
  channels: RetrievalChannel[];
  sourceFile?: string;
  location?: string;
};

export type HybridKnowledgeResult = {
  query: string;
  strategy: RetrievalChannel[];
  hits: HybridKnowledgeHit[];
};

type Candidate = Omit<HybridKnowledgeHit, 'score' | 'channels'> & { score: number; channels: Set<RetrievalChannel> };
type ChunkSearchRow = { id: string; text: string; locationJson: string | null; fileName: string | null };

function termsFor(query: string): string[] {
  const words = query.toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,}|[\u4e00-\u9fff]{2,}/g) ?? [];
  const cjkNgrams = words.flatMap((word) => {
    if (!/^[\u4e00-\u9fff]+$/.test(word) || word.length <= 4) return [];
    const values: string[] = [];
    for (let size = 4; size >= 2; size--) {
      for (let index = 0; index <= word.length - size; index++) values.push(word.slice(index, index + size));
    }
    return values;
  });
  return [...new Set([query.trim(), ...words, ...cjkNgrams].filter((value) => value.length >= 2))].slice(0, 24);
}

function retrievalWeights(query: string): Record<RetrievalChannel, number> {
  const exact = /["“”]|代码|原文|精确|字段|编号|条款/i.test(query);
  const relational = /关系|关联|影响|依赖|上下游|谁|组织|图谱/i.test(query);
  const explanatory = /为什么|如何|总结|概括|类似|相关|含义|方案/i.test(query);
  return {
    keyword: exact ? 1.7 : 1,
    vector: explanatory ? 1.5 : 1.15,
    graph: relational ? 1.65 : 0.9,
    wiki: explanatory ? 1.3 : 0.85,
  };
}

function listKeywordRows(
  db: Database.Database,
  projectId: string,
  terms: string[],
): ChunkSearchRow[] {
  const scopeSql = `((s.scope_type = 'project' AND s.scope_id = ?) OR (s.scope_type = 'shared' AND s.scope_id = 'shared-knowledge'))`;
  const ftsQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');

  try {
    const rows = db.prepare(
      `SELECT c.id, c.text, c.location_json as locationJson, f.name as fileName
       FROM knowledge_chunk_fts
       JOIN knowledge_chunks c ON c.id = knowledge_chunk_fts.id
       JOIN knowledge_sources s ON s.id = c.source_id
       LEFT JOIN files f ON f.id = s.file_id
       WHERE knowledge_chunk_fts MATCH ? AND s.status = 'ready' AND ${scopeSql}
       ORDER BY bm25(knowledge_chunk_fts)
       LIMIT 120`,
    ).all(ftsQuery, projectId) as ChunkSearchRow[];
    if (rows.length > 0) return rows;
  } catch {
    // Older workspaces or SQLite builds without FTS5 use the scoped fallback below.
  }

  const likeSql = terms.map(() => `c.text LIKE ? ESCAPE '\\'`).join(' OR ');
  return db.prepare(
    `SELECT c.id, c.text, c.location_json as locationJson, f.name as fileName
     FROM knowledge_chunks c JOIN knowledge_sources s ON s.id = c.source_id
     LEFT JOIN files f ON f.id = s.file_id
     WHERE s.status = 'ready' AND ${scopeSql} AND (${likeSql}) LIMIT 120`,
  ).all(projectId, ...terms.map((term) => `%${term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`)) as ChunkSearchRow[];
}

export function searchHybridKnowledge(db: Database.Database, query: string, projectId: string, limit = 8): HybridKnowledgeResult {
  const normalized = query.trim();
  if (!normalized) return { query, strategy: [], hits: [] };
  if (!isBuiltinToolEnabled(db, 'tool.hybrid-retriever')) {
    throw new Error('混合知识检索工具已停用');
  }
  const terms = termsFor(normalized);
  const weights = retrievalWeights(normalized);
  const keywordEnabled = isBuiltinToolEnabled(db, 'tool.fts5-search');
  const vectorEnabled = isBuiltinToolEnabled(db, 'tool.local-embedding')
    && isBuiltinToolEnabled(db, 'tool.sqlite-vector-index');
  const candidates = new Map<string, Candidate>();
  const add = (channel: RetrievalChannel, rank: number, hit: Omit<HybridKnowledgeHit, 'score' | 'channels'>): void => {
    const key = `${hit.kind}:${hit.id}`;
    const current = candidates.get(key) ?? { ...hit, score: 0, channels: new Set<RetrievalChannel>() };
    current.score += weights[channel] / (40 + rank);
    current.channels.add(channel);
    candidates.set(key, current);
  };

  const keywordRows = keywordEnabled ? listKeywordRows(db, projectId, terms) : [];
  keywordRows.forEach((row, rank) => add('keyword', rank + 1, {
    id: row.id, kind: 'chunk', title: row.fileName ?? '知识片段', excerpt: row.text.slice(0, 700),
    ...(row.fileName ? { sourceFile: row.fileName } : {}), ...(row.locationJson ? { location: row.locationJson } : {}),
  }));

  const queryVector = vectorEnabled ? embedTextLocally(normalized) : [];
  const embeddings = vectorEnabled ? new KnowledgeRepository(db).listEmbeddings([
    { scopeType: 'project', scopeId: projectId },
    { scopeType: 'shared', scopeId: 'shared-knowledge' },
  ]).map((row) => {
    let vector: number[] = [];
    try { vector = JSON.parse(row.vectorJson) as number[]; } catch { /* invalid legacy row */ }
    return { row, similarity: cosineSimilarity(queryVector, vector) };
  }).filter((item) => item.similarity > 0.08).sort((left, right) => right.similarity - left.similarity).slice(0, 80) : [];
  embeddings.forEach(({ row }, rank) => add('vector', rank + 1, {
    id: row.chunkId, kind: 'chunk', title: row.fileName ?? '语义相关片段', excerpt: row.text.slice(0, 700),
    ...(row.fileName ? { sourceFile: row.fileName } : {}), ...(row.locationJson ? { location: row.locationJson } : {}),
  }));

  const nodeLikeSql = terms.map(() => '(n.canonical_name LIKE ? OR n.summary LIKE ?)').join(' OR ');
  const graphRows = db.prepare(
    `SELECT n.id, n.canonical_name as title, n.summary,
      (SELECT group_concat(other.canonical_name || ' [' || e.edge_type || ']', '；')
       FROM knowledge_edges e
       JOIN knowledge_nodes other ON other.id = CASE WHEN e.source_node_id = n.id THEN e.target_node_id ELSE e.source_node_id END
       WHERE e.source_node_id = n.id OR e.target_node_id = n.id LIMIT 8) as related
     FROM knowledge_nodes n WHERE ((n.scope_type = 'project' AND n.scope_id = ?) OR (n.scope_type = 'shared' AND n.scope_id = 'shared-knowledge'))
       AND (${nodeLikeSql}) LIMIT 80`,
  ).all(projectId, ...terms.flatMap((term) => [`%${term}%`, `%${term}%`])) as Array<{ id: string; title: string; summary: string | null; related: string | null }>;
  graphRows.forEach((row, rank) => add('graph', rank + 1, {
    id: row.id, kind: 'entity', title: row.title, excerpt: [row.summary, row.related ? `关联：${row.related}` : ''].filter(Boolean).join('\n'),
  }));

  const wikiLikeSql = terms.map(() => '(w.title LIKE ? OR w.body_md LIKE ?)').join(' OR ');
  const wikiRows = db.prepare(
    `SELECT w.id, w.title, w.body_md as bodyMd FROM wiki_pages w
     WHERE ((w.scope_type = 'project' AND w.scope_id = ?) OR (w.scope_type = 'shared' AND w.scope_id = 'shared-knowledge'))
       AND (${wikiLikeSql}) LIMIT 60`,
  ).all(projectId, ...terms.flatMap((term) => [`%${term}%`, `%${term}%`])) as Array<{ id: string; title: string; bodyMd: string | null }>;
  wikiRows.forEach((row, rank) => add('wiki', rank + 1, {
    id: row.id, kind: 'wiki', title: row.title, excerpt: (row.bodyMd ?? '').slice(0, 700),
  }));

  const ranked = [...candidates.values()].sort((left, right) => right.score - left.score).slice(0, Math.max(1, Math.min(limit, 30)));
  const maxScore = ranked[0]?.score ?? 1;
  return {
    query,
    strategy: (Object.keys(weights) as RetrievalChannel[])
      .filter((channel) => (channel !== 'keyword' || keywordEnabled) && (channel !== 'vector' || vectorEnabled))
      .sort((left, right) => weights[right] - weights[left]),
    hits: ranked.map((hit) => ({
      id: hit.id, kind: hit.kind, title: hit.title, excerpt: hit.excerpt,
      score: Number((hit.score / maxScore).toFixed(4)), channels: [...hit.channels],
      ...(hit.sourceFile ? { sourceFile: hit.sourceFile } : {}), ...(hit.location ? { location: hit.location } : {}),
    })),
  };
}

export function formatHybridKnowledgeResult(result: HybridKnowledgeResult): string {
  if (result.hits.length === 0) return '未找到相关知识';
  return result.hits.map((hit, index) => {
    const source = hit.sourceFile ? `；来源：${hit.sourceFile}${hit.location ? ` ${hit.location}` : ''}` : '';
    return `[证据 ${index + 1}] ${hit.title}（${hit.channels.join('+')}，相关度 ${Math.round(hit.score * 100)}%${source}）\n${hit.excerpt}`;
  }).join('\n\n');
}
