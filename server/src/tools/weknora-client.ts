import type { WeKnoraConfig } from '../config.js';

export type WeKnoraErrorCode = 'invalid_input' | 'authentication_failed' | 'permission_denied' | 'rate_limited' | 'timeout' | 'queue_full' | 'cancelled' | 'not_configured' | 'invalid_response' | 'unavailable';
const messages: Record<WeKnoraErrorCode, string> = {
  invalid_input: 'WeKnora 查询必须为 1 至 240 字符；请缩短或补充查询。',
  authentication_failed: 'WeKnora 认证失败；请管理员检查服务端 API Key。',
  permission_denied: 'WeKnora 库权限不足；请管理员检查服务端允许库及密钥授权。',
  rate_limited: 'WeKnora 请求受限；请稍后重试或请管理员检查服务配额。',
  timeout: 'WeKnora 检索超时；请稍后重试并请管理员检查连接及超时配置。',
  queue_full: 'WeKnora 检索队列已满；请稍后重试。',
  cancelled: 'WeKnora 检索已取消；需要时请重新发起查询。',
  not_configured: 'WeKnora 尚未正确配置；请管理员配置服务端地址、API Key 和允许库列表。',
  invalid_response: 'WeKnora 响应无效；请管理员检查接口版本、响应大小及库范围。',
  unavailable: 'WeKnora 服务不可用；请管理员检查服务地址及网络后重试。',
};
export class WeKnoraError extends Error {
  constructor(public readonly code: WeKnoraErrorCode) { super(messages[code]); this.name = 'WeKnoraError'; }
}
export type WeKnoraItem = { knowledgeBaseId: string; content: string; title?: string; upstreamId?: string; documentId?: string; fileName?: string };
export type WeKnoraResult = { source: 'weknora'; status: 'ok' | 'no_match'; items: WeKnoraItem[] };
const RESPONSE_LIMIT = 2_000_000;
const CACHE_LIMIT = 128;

function endpointFor(config: WeKnoraConfig): URL {
  try {
    const url = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !config.apiKey.trim() || /[\r\n]/.test(config.apiKey) || !config.knowledgeBaseIds.length || config.knowledgeBaseIds.length > 64 || config.knowledgeBaseIds.some(id => !id.trim() || id.length > 256) || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 120000 || !Number.isInteger(config.maxConcurrent) || config.maxConcurrent < 1 || config.maxConcurrent > 32 || !Number.isInteger(config.queueLimit) || config.queueLimit < 0 || config.queueLimit > 256 || !Number.isInteger(config.cacheTtlMs) || config.cacheTtlMs < 0 || config.cacheTtlMs > 3600000) throw new Error();
    return new URL('/api/v1/knowledge-search', url);
  } catch { throw new WeKnoraError('not_configured'); }
}

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new WeKnoraError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new WeKnoraError('cancelled');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) throw new WeKnoraError('invalid_response');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof WeKnoraError) throw error;
    throw new WeKnoraError('invalid_response');
  } finally {
    signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => {});
  }
}

function parseItems(value: unknown, library: string, key: string): WeKnoraItem[] {
  if (!value || typeof value !== 'object' || !('success' in value) || value.success !== true || !('data' in value) || !Array.isArray(value.data)) throw new WeKnoraError('invalid_response');
  return value.data.map((row: unknown) => {
    if (!row || typeof row !== 'object' || !('content' in row) || typeof row.content !== 'string') throw new WeKnoraError('invalid_response');
    if ('knowledge_base_id' in row && row.knowledge_base_id !== library) throw new WeKnoraError('permission_denied');
    const item: WeKnoraItem = { knowledgeBaseId: library, content: row.content };
    const title = 'knowledge_title' in row && typeof row.knowledge_title === 'string' ? row.knowledge_title : 'document_name' in row && typeof row.document_name === 'string' ? row.document_name : undefined;
    if (title) item.title = title;
    if ('id' in row && (typeof row.id === 'string' || (typeof row.id === 'number' && Number.isFinite(row.id)))) item.upstreamId = String(row.id);
    // v0.8.2 SearchResult distinguishes search-result id from knowledge_id.
    // Preserve only actual source metadata; offsets/positions need not address
    // the returned merged content and therefore are intentionally omitted.
    if ('knowledge_id' in row) {
      if (typeof row.knowledge_id !== 'string') throw new WeKnoraError('invalid_response');
      if (row.knowledge_id.trim()) item.documentId = row.knowledge_id;
    }
    if ('knowledge_filename' in row) {
      if (typeof row.knowledge_filename !== 'string') throw new WeKnoraError('invalid_response');
      if (row.knowledge_filename.trim()) item.fileName = row.knowledge_filename;
    }
    // Never expose a credential even if a broken upstream echoes it in result fields.
    if (JSON.stringify(item).includes(key)) throw new WeKnoraError('invalid_response');
    return item;
  });
}

/** One client owns an immutable configuration and isolated cache. No failure is cached. */
export function createWeKnoraClient(input: WeKnoraConfig, fetcher: typeof fetch = fetch) {
  const config = { ...input, knowledgeBaseIds: [...new Set(input.knowledgeBaseIds)] };
  const cache = new Map<string, { expires: number; result: WeKnoraResult }>();
  type Job = { run: () => void };
  const queue: Job[] = [];
  let active = 0;
  const pump = () => {
    while (active < config.maxConcurrent && queue.length) queue.shift()!.run();
  };
  return {
    async search(rawQuery: string, signal?: AbortSignal): Promise<WeKnoraResult> {
      if (typeof rawQuery !== 'string' || !rawQuery.trim() || rawQuery.trim().length > 240) throw new WeKnoraError('invalid_input');
      const query = rawQuery.trim();
      const endpoint = endpointFor(config);
      if (signal?.aborted) throw new WeKnoraError('cancelled');
      // The entire cache belongs to this exact configuration, including credentials,
      // libraries and version. Never share caches between independently configured clients.
      for (const [key, entry] of cache) if (entry.expires <= Date.now()) cache.delete(key);
      const cached = cache.get(query);
      if (cached) return structuredClone(cached.result);
      if (active >= config.maxConcurrent && queue.length >= config.queueLimit) throw new WeKnoraError('queue_full');
      return new Promise<WeKnoraResult>((resolve, reject) => {
        const controller = new AbortController();
        let finished = false;
        let started = false;
        let timer: ReturnType<typeof setTimeout>;
        const finish = (error?: WeKnoraError, result?: WeKnoraResult) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          const index = queue.indexOf(job);
          if (index >= 0) queue.splice(index, 1);
          if (started) active--;
          if (error) { controller.abort(); reject(error); } else resolve(structuredClone(result!));
          pump();
        };
        const cancel = () => finish(new WeKnoraError('cancelled'));
        const job: Job = { run: () => {
          started = true;
          active++;
          void (async () => {
            try {
              const items: WeKnoraItem[] = [];
              for (const library of config.knowledgeBaseIds) {
                if (controller.signal.aborted) return;
                const response = await fetcher(endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiKey }, body: JSON.stringify({ query, knowledge_base_id: library }), signal: controller.signal });
                if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); return; }
                if (!response.ok) {
                  void response.body?.cancel().catch(() => {});
                  throw new WeKnoraError(response.status === 401 ? 'authentication_failed' : response.status === 403 ? 'permission_denied' : response.status === 429 ? 'rate_limited' : 'unavailable');
                }
                items.push(...parseItems(await readResponse(response, controller.signal), library, config.apiKey));
                // Bound aggregate output across all configured libraries as well.
                if (Buffer.byteLength(JSON.stringify(items)) > RESPONSE_LIMIT) throw new WeKnoraError('invalid_response');
              }
              if (finished) return;
              const result: WeKnoraResult = { source: 'weknora', status: items.length ? 'ok' : 'no_match', items };
              if (config.cacheTtlMs > 0) {
                while (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
                cache.set(query, { expires: Date.now() + config.cacheTtlMs, result });
              }
              finish(undefined, result);
            } catch (error) { finish(error instanceof WeKnoraError ? error : new WeKnoraError('unavailable')); }
          })();
        } };
        timer = setTimeout(() => finish(new WeKnoraError('timeout')), config.timeoutMs);
        signal?.addEventListener('abort', cancel, { once: true });
        queue.push(job);
        pump();
      });
    },
  };
}
