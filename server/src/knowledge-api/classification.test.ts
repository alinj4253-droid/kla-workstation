import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createScope, inScope, MemoryKnowledgeStore } from './context.js';
import { documentProof, listSources } from './documents.js';
import { KnowledgeError } from './transport.js';
const mock = vi.hoisted(() => ({ request: vi.fn(), service: vi.fn() }));
vi.mock('./transport.js', async original => ({ ...await original<typeof import('./transport.js')>(), jsonRequest: mock.request }));
vi.mock('./config.js', () => ({ assertService: mock.service, atomicJson: vi.fn().mockResolvedValue(undefined), authHeaders: () => ({}) }));
const doc = { doc_id: 'fixture-doc', name: 'fixture.txt', category: '上传文档', ext: 'txt', size: 1, modified: 'fixture-version', stale: false, readable: true, abs_path: '/fixture.txt' };
const proof = { doc_id: doc.doc_id, collection: '项目知识库', count: 1, slices: [{}], source: doc.name };
const scope = () => createScope('fixture-identity', 1, new MemoryKnowledgeStore(), '');
beforeEach(() => {
  vi.clearAllMocks();
  mock.service.mockReturnValue({ baseUrl: 'http://fixture.invalid', collection: '项目知识库', secretRef: null, settings: { requestTimeoutMs: 120000 } });
  mock.request.mockResolvedValue(proof);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('bounded document classification', () => {
  it('passes the per-document timeout through the real HTTP transport', async () => {
    const { jsonRequest } = await vi.importActual<typeof import('./transport.js')>('./transport.js');
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true });
    })));
    await expect(inScope(scope(), () => jsonRequest(1, 'service-a', '/health', z.unknown(), {}, undefined, 20))).rejects.toThrow('超时');
  });
  it('deduplicates concurrent reads and caches proofs across collection switches', async () => {
    await inScope(scope(), async () => {
      const [first, second] = await Promise.all([documentProof(1, 'service-a', doc), documentProof(1, 'service-a', doc)]);
      expect(first).toEqual(second);
      expect(mock.request).toHaveBeenCalledTimes(1);
      expect(mock.request.mock.calls[0]![6]).toBe(5000);
      await documentProof(1, 'service-b', doc);
      expect(mock.request).toHaveBeenCalledTimes(1);
    });
  });
  it('keeps a timed out source unresolved rather than hanging the whole library', async () => {
    mock.request.mockRejectedValue(new KnowledgeError('RUN_CANCELLED', 'timeout'));
    const result = await inScope(scope(), () => documentProof(1, 'service-a', doc));
    expect(result.collection).toBeNull();
    expect(result.count).toBe(0);
  });
  it('does not suppress authorization errors', async () => {
    mock.request.mockRejectedValue(new KnowledgeError('PERMISSION_DENIED', 'forbidden'));
    await expect(inScope(scope(), () => documentProof(1, 'service-a', doc))).rejects.toThrow('forbidden');
  });
  it('bounds total scan work and reports sources that still need classification', async () => {
    let clock = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const documents = Array.from({ length: 10 }, (_, index) => ({ ...doc, doc_id: String(index), name: index + '.txt' }));
    mock.request.mockImplementation(async (_owner, _service, path) => {
      if (path.startsWith('/v1/documents?')) return { count: documents.length, documents };
      clock += 6000;
      const doc_id = path.split('/')[3];
      return { ...proof, doc_id };
    });
    const result = await inScope(scope(), () => listSources(1, 'service-a', '项目知识库', 'http://fixture.invalid', null));
    expect(result.documents.length).toBeLessThan(10);
    expect(result.unclassifiedCount).toBe(10 - result.documents.length);
  });
});