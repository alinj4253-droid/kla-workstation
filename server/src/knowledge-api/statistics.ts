import { documentListSchema, type KnowledgeStatistics, type LibraryEntry } from '@kla-workstation/contracts/knowledge';
import { assertService } from './config.js';
import { documentProof, matchedDocumentBinding } from './documents.js';
import { jsonRequest, KnowledgeError } from './transport.js';
import { z } from 'zod';

const scopedStatisticsSchema = z.object({
  permission_filtered: z.literal(true),
  collections: z.array(z.object({
    knowledge_base_id: z.string().uuid(), collection: z.string(),
    file_count: z.number().int().nonnegative(), chunk_count: z.number().int().nonnegative(),
    source_names: z.array(z.string()),
  })),
});

export async function scopedLibraryStatistics(owner: number, serviceId: string, entries: LibraryEntry[]): Promise<KnowledgeStatistics> {
  assertService(serviceId);
  if (!entries.length) return { collections: [], unclassifiedCount: 0 };
  const result = await jsonRequest(owner, serviceId, '/v1/knowledge-scope/statistics', scopedStatisticsSchema, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ knowledge_base_ids: entries.map(entry => entry.id) }),
  });
  const expected = new Map(entries.map(entry => [entry.id, entry.collection]));
  if (result.collections.length !== expected.size || result.collections.some(item => expected.get(item.knowledge_base_id) !== item.collection)) {
    throw new KnowledgeError('KNOWLEDGE_INGEST_FAILED', '知识服务返回的统计范围与授权知识库不一致。');
  }
  const seen = new Set(result.collections.map(item => item.knowledge_base_id));
  if (seen.size !== expected.size) throw new KnowledgeError('KNOWLEDGE_INGEST_FAILED', '知识服务返回了重复的知识库统计。');
  assertService(serviceId);
  return { collections: result.collections.map(item => ({ knowledgeBaseId: item.knowledge_base_id, collection: item.collection,
    fileCount: item.file_count, chunkCount: item.chunk_count, sourceNames: item.source_names })), unclassifiedCount: 0 };
}

/** Reads all authorized catalog collections without changing the active upload/reader connection. */
export async function libraryStatistics(owner: number, serviceId: string, entries: LibraryEntry[]): Promise<KnowledgeStatistics> {
  assertService(serviceId);
  const result = await jsonRequest(owner, serviceId, '/v1/documents?category=' + encodeURIComponent('上传文档'), documentListSchema, {}, undefined, 10000);
  const collections = [...new Set(entries.map(entry => entry.collection).filter(Boolean))];
  const counters = new Map(collections.map(collection => [collection, { collection, fileCount: 0, chunkCount: 0, sourceNames: [] as string[] }]));
  const scanned = result.documents.slice().sort((a,b) => b.modified.localeCompare(a.modified)).slice(0, 200);
  let unclassifiedCount = result.documents.length - scanned.length;
  let cursor = 0;
  const scanDeadline = Date.now() + 10000;
  await Promise.all(Array.from({ length: Math.min(3, scanned.length) }, async () => {
    while (cursor < scanned.length && Date.now() < scanDeadline) {
      const doc = scanned[cursor++]!;
      const proof = await documentProof(owner, serviceId, doc);
      if (!proof.collection) unclassifiedCount++;
      for (const [collection, counter] of counters) {
        const binding = matchedDocumentBinding(serviceId, collection, doc);
        if (proof.collection !== collection && !binding) continue;
        counter.fileCount++;
        counter.chunkCount += proof.collection === collection ? proof.count : 0;
        counter.sourceNames.push(binding?.displayName ?? doc.name);
      }
    }
  }));
  unclassifiedCount += scanned.length - cursor;
  assertService(serviceId);
  return { collections: [...counters.values()], unclassifiedCount };
}
