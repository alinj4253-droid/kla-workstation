import { documentListSchema, type KnowledgeStatistics, type LibraryEntry } from '@kla-workstation/contracts/knowledge';
import { assertService } from './config.js';
import { documentProof, matchedDocumentBinding } from './documents.js';
import { jsonRequest } from './transport.js';

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
