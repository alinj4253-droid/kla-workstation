import { z } from 'zod';
import { sliceEditRequestSchema } from '@kla-workstation/contracts/knowledge';
import { atomicStored, readStored } from './context.js';
import { KnowledgeError } from './transport.js';

/**
 * 切片编辑覆盖层（原型「甲方第八轮：切片可编辑」）。
 *
 * 设计取舍：切片正文与向量在**上游知识服务**里，KLA 不重写它们；这里按身份保存
 * 「docId + sliceId → 标题/正文」的覆盖内容，读取切片时叠加返回。好处是：
 *  - 上游无需新增写接口，重新入库/重建切片后覆盖依然生效；
 *  - 编辑只影响本身份看到的切片内容，不会污染其他身份或原始文件。
 *
 * 存储复用现有的 per-identity client state（与 catalog.json / bindings.json 同一套），
 * mock/local 模式下自动落到内存实现。
 */
const editSchema = z.object({ title: z.string(), content: z.string(), updatedAt: z.string() });
const storeSchema = z.record(z.string(), z.record(z.string(), editSchema));
export type SliceEdit = z.infer<typeof editSchema>;
type EditStore = Record<string, Record<string, SliceEdit>>;

async function loadStore(): Promise<EditStore> {
  try { return storeSchema.parse(await readStored('slice-edits.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}

export async function saveSliceEdit(raw: unknown): Promise<{ updatedAt: string }> {
  const input = sliceEditRequestSchema.parse(raw);
  if (!input.title && !input.content) throw new KnowledgeError('VALIDATION_FAILED', '切片标题与正文不能同时为空。');
  const store = await loadStore();
  const docEdits = { ...(store[input.docId] ?? {}) };
  const edit: SliceEdit = { title: input.title, content: input.content, updatedAt: new Date().toISOString() };
  docEdits[String(input.sliceId)] = edit;
  await atomicStored('slice-edits.json', { ...store, [input.docId]: docEdits });
  return { updatedAt: edit.updatedAt };
}

/** 该文档在本身份下的全部切片覆盖；没有编辑时返回空 Map（调用方据此跳过叠加）。 */
export async function loadSliceEdits(docId: string): Promise<Map<number, SliceEdit>> {
  const store = await loadStore();
  const docEdits = store[docId];
  if (!docEdits) return new Map();
  return new Map(Object.entries(docEdits).map(([id, edit]) => [Number(id), edit]));
}

/** 把覆盖内容叠加到上游切片响应上；只改标题与正文，计数与其它字段保持上游原值。 */
export function applySliceEdits<T>(data: T, edits: Map<number, SliceEdit>): T {
  if (!edits.size || !data || typeof data !== 'object') return data;
  const slices = (data as { slices?: unknown }).slices;
  if (!Array.isArray(slices)) return data;
  return {
    ...(data as Record<string, unknown>),
    slices: slices.map(slice => {
      if (!slice || typeof slice !== 'object') return slice;
      const edit = edits.get(Number((slice as { id?: unknown }).id));
      return edit ? { ...(slice as Record<string, unknown>), title: edit.title || (slice as { title?: string }).title || '', content: edit.content } : slice;
    }),
  } as T;
}
