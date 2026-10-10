import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryEntry } from '@kla-workstation/contracts/knowledge';
import { libraryStatistics, scopedLibraryStatistics } from './statistics.js';
const mock = vi.hoisted(() => ({ request: vi.fn(), proof: vi.fn(), binding: vi.fn(), service: vi.fn() }));
const catalogEntries: LibraryEntry[] = [
  { id: '00000000-0000-4000-8000-000000000001', name: '公司知识库', description: '', scope: 'company', collection: '金牌知识库', updatedAt: '2026-10-10T00:00:00.000Z' },
  { id: '00000000-0000-4000-8000-000000000002', name: '项目知识库', description: '', scope: 'project', collection: '项目知识库', updatedAt: '2026-10-10T00:00:00.000Z' },
  { id: '00000000-0000-4000-8000-000000000003', name: '个人知识库', description: '', scope: 'personal', collection: '个人知识库', updatedAt: '2026-10-10T00:00:00.000Z' },
];
vi.mock('./transport.js', () => ({ jsonRequest: mock.request, KnowledgeError: class KnowledgeError extends Error {
  constructor(_code: string, message: string) { super(message); }
} }));
vi.mock('./config.js', () => ({ assertService: mock.service }));
vi.mock('./documents.js', () => ({ documentProof: mock.proof, matchedDocumentBinding: mock.binding }));
beforeEach(() => {
  vi.clearAllMocks();
  mock.service.mockReturnValue({ collection: '金牌知识库' });
  mock.binding.mockReturnValue(undefined);
  mock.request.mockResolvedValue({ count: 4, documents: ['company', 'project', 'other', 'unknown'].map(doc_id => ({ doc_id, name: doc_id + '.txt', modified: '', abs_path: '/fixtures/' + doc_id })) });
  mock.proof.mockImplementation(async (_owner, _service, doc) => ({ collection: ({ company: '金牌知识库', project: '项目知识库', other: '其他集合' } as Record<string,string>)[doc.doc_id] ?? null, count: doc.doc_id === 'company' ? 7 : 3 }));
});
describe('read-only library statistics', () => {
  it('separates catalog collections, shows empty libraries and excludes unrelated sources', async () => {
    const result = await libraryStatistics(1, 'fixture-service', catalogEntries);
    expect(result.collections).toEqual([
      { collection: '金牌知识库', fileCount: 1, chunkCount: 7, sourceNames: ['company.txt'] },
      { collection: '项目知识库', fileCount: 1, chunkCount: 3, sourceNames: ['project.txt'] },
      { collection: '个人知识库', fileCount: 0, chunkCount: 0, sourceNames: [] },
    ]);
    expect(result.unclassifiedCount).toBe(1);
    expect(mock.service).toHaveBeenCalledWith('fixture-service');
  });
  it('does not double count collections shared by catalog entries', async () => {
    const result = await libraryStatistics(1, 'fixture-service', [...catalogEntries, { ...catalogEntries[0]!, id: '00000000-0000-4000-8000-000000000004' }]);
    expect(result.collections).toHaveLength(3);
    expect(result.collections[0]!.fileCount).toBe(1);
  });
  it('counts an exactly bound source pending slices without inventing chunks', async () => {
    mock.binding.mockImplementation((_service, collection, doc) => collection === '个人知识库' && doc.doc_id === 'unknown' ? { displayName: 'pending.txt' } : undefined);
    const result = await libraryStatistics(1, 'fixture-service', catalogEntries);
    expect(result.collections[2]).toEqual({ collection: '个人知识库', fileCount: 1, chunkCount: 0, sourceNames: ['pending.txt'] });
  });
  it('propagates unavailable/forbidden upstream responses instead of displaying false zeros', async () => {
    mock.proof.mockRejectedValue(new Error('forbidden'));
    await expect(libraryStatistics(1, 'fixture-service', catalogEntries)).rejects.toThrow('forbidden');
  });
});

describe('scoped library statistics', () => {
  it('requests only accessible library IDs and maps the verified response', async () => {
    mock.request.mockResolvedValue({ permission_filtered: true, collections: catalogEntries.map(entry => ({
      knowledge_base_id: entry.id, collection: entry.collection, file_count: 1,
      chunk_count: 2, source_names: [entry.name],
    })) });
    const result = await scopedLibraryStatistics(1, 'fixture-service', catalogEntries);
    expect(mock.request).toHaveBeenCalledWith(1, 'fixture-service', '/v1/knowledge-scope/statistics', expect.anything(), expect.objectContaining({
      method: 'POST', body: JSON.stringify({ knowledge_base_ids: catalogEntries.map(entry => entry.id) }),
    }));
    expect(result.collections.map(item => item.knowledgeBaseId)).toEqual(catalogEntries.map(entry => entry.id));
  });

  it('rejects statistics for an unexpected library', async () => {
    mock.request.mockResolvedValue({ permission_filtered: true, collections: [{
      knowledge_base_id: '00000000-0000-4000-8000-000000000099', collection: catalogEntries[0]!.collection,
      file_count: 1, chunk_count: 1, source_names: ['private.txt'],
    }] });
    await expect(scopedLibraryStatistics(1, 'fixture-service', catalogEntries.slice(0, 1)))
      .rejects.toThrow('统计范围与授权知识库不一致');
  });
});
