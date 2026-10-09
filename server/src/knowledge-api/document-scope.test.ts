import { beforeEach, describe, expect, it, vi } from 'vitest';

// 只替换 jsonRequest（远端 HTTP 层），其余保持真实实现，保证 KnowledgeError 的 instanceof 一致。
const jsonRequestMock = vi.hoisted(() => vi.fn());
vi.mock('./transport.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./transport.js')>();
  return { ...actual, jsonRequest: jsonRequestMock };
});

import { assertBoundResource, verifyDocumentScope } from './documents.js';
import { dispatchKnowledge } from './dispatch.js';
import { configureConnection, serviceUrl } from './config.js';
import { createScope, inScope, MemoryKnowledgeStore } from './context.js';

const proof = (docId: string, collection: string) => ({
  doc_id: docId, source: '测温视频.mp4', collection, count: 1,
  slices: [{ id: 1, title: '切片1', content: '内容', group: null }],
});

async function setupScope(collection: string): Promise<string> {
  // configureConnection 每次生成新的 serviceInstanceId（connectionInputSchema 不含该字段）
  const connection = await configureConnection({ baseUrl: serviceUrl, collection, clearCredential: true });
  return connection.serviceInstanceId;
}

beforeEach(() => { jsonRequestMock.mockReset(); });

describe('非本机上传文档的归属补验', () => {
  it('远端确认归属后放行，并延长验证缓存使 assertBoundResource 通过', async () => {
    await inScope(createScope('owner-1', 1, new MemoryKnowledgeStore(), 'enc-key'), async () => {
      const serviceId = await setupScope('col-a');
      jsonRequestMock.mockResolvedValue(proof('doc-x', 'col-a'));
      await expect(verifyDocumentScope(1, serviceId, 'doc-x')).resolves.toBe(true);
      expect(() => assertBoundResource(serviceId, { docId: 'doc-x' })).not.toThrow();
    });
  });

  it('远端归属集合不匹配时拒绝（不越权放行）', async () => {
    await inScope(createScope('owner-2', 2, new MemoryKnowledgeStore(), 'enc-key'), async () => {
      const serviceId = await setupScope('col-a');
      jsonRequestMock.mockResolvedValue(proof('doc-y', 'col-other'));
      await expect(verifyDocumentScope(2, serviceId, 'doc-y')).resolves.toBe(false);
      expect(() => assertBoundResource(serviceId, { docId: 'doc-y' })).toThrow(/尚未确认关联/);
    });
  });

  it('远端请求失败时拒绝', async () => {
    await inScope(createScope('owner-3', 3, new MemoryKnowledgeStore(), 'enc-key'), async () => {
      const serviceId = await setupScope('col-a');
      jsonRequestMock.mockRejectedValue(new Error('network down'));
      await expect(verifyDocumentScope(3, serviceId, 'doc-z')).resolves.toBe(false);
    });
  });
});

describe('contentRequest 全链路：未绑定文档先补验再读取', () => {
  it('不在绑定表的文档通过实时补验后正常返回切片（此前整片 403）', async () => {
    await inScope(createScope('owner-4', 4, new MemoryKnowledgeStore(), 'enc-key'), async () => {
      const serviceId = await setupScope('col-a');
      jsonRequestMock.mockResolvedValue(proof('doc-mp4', 'col-a'));
      const result = await dispatchKnowledge('contentRequest', { serviceInstanceId: serviceId, endpoint: 'slices', docId: 'doc-mp4' }) as { doc_id: string; count: number };
      expect(result.doc_id).toBe('doc-mp4');
      expect(result.count).toBe(1);
      // 补验（一次）+ 实际读取（一次）
      expect(jsonRequestMock).toHaveBeenCalledTimes(2);
      expect(jsonRequestMock.mock.calls.every(call => String(call[2]).includes('/v1/documents/doc-mp4/slices'))).toBe(true);
    });
  });

  it('远端拒绝归属时保持 403 语义（PERMISSION_DENIED）', async () => {
    await inScope(createScope('owner-5', 5, new MemoryKnowledgeStore(), 'enc-key'), async () => {
      const serviceId = await setupScope('col-a');
      // 补验请求本身被远端拒绝（如凭证无效）：验证窗口无法建立，按 fail-closed
      // 原样抛回 assertBoundResource 的 PERMISSION_DENIED（与旧行为一致）
      jsonRequestMock.mockRejectedValue(Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' }));
      await expect(dispatchKnowledge('contentRequest', { serviceInstanceId: serviceId, endpoint: 'slices', docId: 'doc-nope' }))
        .rejects.toThrow(/尚未确认关联/);
    });
  });
});
