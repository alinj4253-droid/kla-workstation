import { describe, expect, it } from 'vitest';
import { MemoryKnowledgeStore, createScope, inScope } from './context.js';
import { applySliceEdits, loadSliceEdits, saveSliceEdit } from './slice-edits.js';

/** 每次用例一个独立身份作用域（与真实请求一致：所有切片编辑按 identity 隔离）。 */
function scope(owner = 'identity-a', ownerNumber = 1) {
  return createScope(owner, ownerNumber, new MemoryKnowledgeStore(), 'encryption-key');
}

const slices = () => ({
  doc_id: 'doc-1', source: 'doc-1.txt', collection: 'kb-demo', count: 2,
  slices: [
    { id: 0, title: '第一条', content: '原始正文 0' },
    { id: 1, title: '第二条', content: '原始正文 1' },
  ],
});

describe('切片编辑覆盖层', () => {
  it('保存后按 doc + slice 叠加标题与正文，且刷新更新时间', async () => {
    // 同一作用域 = 同一身份：routes.ts 会按 identity 复用 scope（连同它的 client state store）。
    const s = scope();
    const { updatedAt } = await inScope(s, () => saveSliceEdit({ serviceInstanceId: 'svc', docId: 'doc-1', sliceId: 1, title: '改过的标题', content: '改过的正文' }));
    expect(Number.isNaN(Date.parse(updatedAt))).toBe(false);

    const data = await inScope(s, async () => applySliceEdits(slices(), await loadSliceEdits('doc-1')));
    expect(data.slices[1]).toMatchObject({ id: 1, title: '改过的标题', content: '改过的正文' });
    // 未编辑的切片保持上游原值，计数不变（前端 schema 校验依赖这些字段）。
    expect(data.slices[0]).toMatchObject({ id: 0, title: '第一条', content: '原始正文 0' });
    expect(data.count).toBe(2);
  });

  it('没有编辑时原样返回，不产生多余对象', async () => {
    const original = slices();
    const data = await inScope(scope('identity-b', 2), async () => applySliceEdits(original, await loadSliceEdits('doc-1')));
    expect(data).toBe(original);
  });

  it('按身份隔离：另一个身份读不到这份编辑', async () => {
    const mine = scope('identity-a', 1);
    const other = scope('identity-b', 2);
    await inScope(mine, () => saveSliceEdit({ serviceInstanceId: 'svc', docId: 'doc-1', sliceId: 0, title: 'A 的标题', content: 'A 的正文' }));
    expect((await inScope(other, () => loadSliceEdits('doc-1'))).size).toBe(0);
    expect((await inScope(mine, () => loadSliceEdits('doc-1'))).get(0)?.title).toBe('A 的标题');
  });

  it('拒绝空白正文与非法切片编号', async () => {
    await expect(inScope(scope(), () => saveSliceEdit({ serviceInstanceId: 'svc', docId: 'doc-1', sliceId: 0, title: '', content: '   ' }))).rejects.toThrow();
    await expect(inScope(scope(), () => saveSliceEdit({ serviceInstanceId: 'svc', docId: 'doc-1', sliceId: -1, title: 'x', content: 'y' }))).rejects.toThrow();
  });
});
