import type { KnowledgeBApi, KnowledgeSource, OpenKnowledgeSource, RpcResult } from '@kla-workstation/contracts/knowledge';
export interface QueryContext { api: KnowledgeBApi; cacheScope: string; resourceVersion?: string | undefined }
const messages: Record<string, string> = {
  unconfigured: '知识服务尚未配置，请等待基础接入。', validation: '请求参数无效。',
  unauthorized: '知识服务鉴权失败。', forbidden: '没有权限读取该文档。',
  not_found: '文档不存在。', slices_pending: '该文档尚未生成切片。',
  network: '知识服务网络连接失败。', timeout: '知识服务请求超时。',
  protocol: '知识服务返回的数据不符合接口契约。', server: '知识服务处理失败。', cancelled: '请求已取消。',
};
export class BQueryError extends Error {
  constructor(public readonly kind: string) { super(messages[kind] ?? '知识服务请求失败。'); }
}
export function unwrap<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new BQueryError(typeof result.error.details?.kind === 'string' ? result.error.details.kind : 'server');
  return result.data;
}
export const bKey = (scope: string, ...parts: readonly unknown[]): readonly unknown[] => ['knowledgeLibrary', 'reading', scope, ...parts];
export function resolveSource(sources: readonly KnowledgeSource[], collection: string, source: string | null | undefined): OpenKnowledgeSource | undefined {
  if (!source) return undefined;
  const matches = sources.filter(item => item.collection === collection && item.searchSources.includes(source));
  return matches.length === 1 ? { docId: matches[0]!.docId } : undefined;
}
