import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialKnowledgeCatalog } from '@kla-workstation/contracts/knowledge';
import { libraryStatistics } from './statistics.js';
const mock = vi.hoisted(() => ({ request: vi.fn(), proof: vi.fn(), binding: vi.fn(), service: vi.fn() }));
vi.mock('./transport.js', () => ({ jsonRequest: mock.request }));
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
    const result = await libraryStatistics(1, 'fixture-service', initialKnowledgeCatalog);
    expect(result.collections).toEqual([
      { collection: '金牌知识库', fileCount: 1, chunkCount: 7, sourceNames: ['company.txt'] },
      { collection: '项目知识库', fileCount: 1, chunkCount: 3, sourceNames: ['project.txt'] },
      { collection: '个人知识库', fileCount: 0, chunkCount: 0, sourceNames: [] },
    ]);
    expect(result.unclassifiedCount).toBe(1);
    expect(mock.service).toHaveBeenCalledWith('fixture-service');
  });
  it('does not double count collections shared by catalog entries', async () => {
    const result = await libraryStatistics(1, 'fixture-service', [...initialKnowledgeCatalog, { ...initialKnowledgeCatalog[0]!, id: 'alias' }]);
    expect(result.collections).toHaveLength(3);
    expect(result.collections[0]!.fileCount).toBe(1);
  });
  it('counts an exactly bound source pending slices without inventing chunks', async () => {
    mock.binding.mockImplementation((_service, collection, doc) => collection === '个人知识库' && doc.doc_id === 'unknown' ? { displayName: 'pending.txt' } : undefined);
    const result = await libraryStatistics(1, 'fixture-service', initialKnowledgeCatalog);
    expect(result.collections[2]).toEqual({ collection: '个人知识库', fileCount: 1, chunkCount: 0, sourceNames: ['pending.txt'] });
  });
  it('propagates unavailable/forbidden upstream responses instead of displaying false zeros', async () => {
    mock.proof.mockRejectedValue(new Error('forbidden'));
    await expect(libraryStatistics(1, 'fixture-service', initialKnowledgeCatalog)).rejects.toThrow('forbidden');
  });
});