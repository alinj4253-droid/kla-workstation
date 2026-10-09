// 博查客户端单测：请求组装、{msg,data} 信封解析、站点过滤归一、错误码映射、重试与超时语义。
// 移植自旧版 chat 分支 bocha-web-search.test.ts 的可用用例，剥离 electron/better-sqlite3 依赖，
// 以注入 fetchImpl 的方式替代全局 fetch mock。

import { describe, expect, it, vi } from 'vitest';
import { BochaClientError, createBochaClient, formatBochaSearchResults, parseBochaResults } from './bocha-client.js';

type FetchCall = { url: string; init: RequestInit };

function okEnvelope(results: unknown[]) {
  return new Response(JSON.stringify({ data: { webPages: { value: results } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** 记录调用的 fetch 桩；handlers 按调用次序返回，超出后复用最后一个。 */
function fetchStub(...handlers: Array<(call: FetchCall) => Response>) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    return handler(call);
  });
  return { calls, impl };
}

function client(fetchImpl: ReturnType<typeof fetchStub>['impl']) {
  return createBochaClient({ apiKey: 'k-test', retryDelayMs: 0, fetchImpl });
}

describe('bocha-client', () => {
  it('组装请求并解析 { data: { webPages } } 信封', async () => {
    const stub = fetchStub(() => okEnvelope([
      { name: 'Example', url: 'https://example.com', snippet: 'A result', siteName: 'Example', datePublished: '2026-08-10T00:00:00Z' },
      { name: 'NoUrl' },
    ]));
    const results = await client(stub.impl).searchWeb({ query: '  example  ' });

    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.url).toBe('https://api.bocha.cn/v1/web-search');
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>).Authorization).toBe('Bearer k-test');
    expect(JSON.parse(String(call.init.body))).toMatchObject({ query: 'example', count: 5, freshness: 'noLimit', summary: true });

    // 无 url 的条目被过滤；datePublished 映射为 publishedAt
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ title: 'Example', url: 'https://example.com', snippet: 'A result', siteName: 'Example', publishedAt: '2026-08-10T00:00:00Z' });
  });

  it('include/exclude 归一为逗号串并截断到 20 个', async () => {
    const stub = fetchStub(() => okEnvelope([]));
    await client(stub.impl).searchWeb({
      query: 'example',
      include: Array.from({ length: 25 }, (_, i) => `site${i}.com`),
      exclude: [' bad.com ', 'bad.com', ''],
    });

    const body = JSON.parse(String(stub.calls[0]!.init.body));
    expect(body.include).toBe(Array.from({ length: 20 }, (_, i) => `site${i}.com`).join(','));
    expect(body.exclude).toBe('bad.com');
  });

  it('count 收敛到 1..20', async () => {
    const stub = fetchStub(() => okEnvelope([]));
    const c = client(stub.impl);
    await c.searchWeb({ query: 'a', count: 99 });
    await c.searchWeb({ query: 'a', count: 0 });
    expect(JSON.parse(String(stub.calls[0]!.init.body)).count).toBe(20);
    expect(JSON.parse(String(stub.calls[1]!.init.body)).count).toBe(1);
  });

  it('空 query 抛 invalid_argument 且不发起请求', async () => {
    const stub = fetchStub(() => okEnvelope([]));
    await expect(client(stub.impl).searchWeb({ query: '   ' })).rejects.toMatchObject({ kind: 'invalid_argument' });
    expect(stub.calls).toHaveLength(0);
  });

  it('缺少 API Key 抛 unauthorized 且不发起请求', async () => {
    const stub = fetchStub(() => okEnvelope([]));
    await expect(createBochaClient({ apiKey: '  ', fetchImpl: stub.impl }).searchWeb({ query: 'a' }))
      .rejects.toMatchObject({ kind: 'unauthorized' });
    expect(stub.calls).toHaveLength(0);
  });

  it('错误码映射：400/401/403 不重试，msg 作为上游信息', async () => {
    const cases: Array<{ status: number; kind: string; calls: number }> = [
      { status: 400, kind: 'invalid_argument', calls: 1 },
      { status: 401, kind: 'unauthorized', calls: 1 },
      { status: 403, kind: 'upstream_exhausted', calls: 1 },
    ];
    for (const item of cases) {
      const stub = fetchStub(() => new Response(JSON.stringify({ msg: 'some upstream reason' }), { status: item.status }));
      const error = await client(stub.impl).searchWeb({ query: 'a' }).catch((e: unknown) => e as BochaClientError);
      expect(error).toBeInstanceOf(BochaClientError);
      expect((error as BochaClientError).kind).toBe(item.kind);
      expect((error as BochaClientError).upstreamMessage).toBe('some upstream reason');
      expect(stub.calls).toHaveLength(item.calls);
    }
  });

  it('429 退避重试 1 次后仍失败 → rate_limited，共两次请求', async () => {
    const stub = fetchStub(() => new Response('{}', { status: 429 }));
    await expect(client(stub.impl).searchWeb({ query: 'a' })).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(stub.calls).toHaveLength(2);
  });

  it('5xx 第一次失败、第二次成功 → 正常返回', async () => {
    const stub = fetchStub(
      () => new Response('boom', { status: 500 }),
      () => okEnvelope([{ name: 'Recovered', url: 'https://example.com' }]),
    );
    const results = await client(stub.impl).searchWeb({ query: 'a' });
    expect(stub.calls).toHaveLength(2);
    expect(results).toHaveLength(1);
  });

  it('200 但无结果且带 msg → 按 upstream_error 处理', async () => {
    const stub = fetchStub(() => new Response(JSON.stringify({ msg: '服务繁忙' }), { status: 200 }));
    await expect(client(stub.impl).searchWeb({ query: 'a' })).rejects.toMatchObject({ kind: 'upstream_error' });
  });

  it('超时抛 timeout 且不重试', async () => {
    const impl = vi.fn(async (_url: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const c = createBochaClient({ apiKey: 'k-test', timeoutMs: 20, retryDelayMs: 0, fetchImpl: impl });
    await expect(c.searchWeb({ query: 'a' })).rejects.toMatchObject({ kind: 'timeout' });
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('parseBochaResults 对顶层 webPages 形态（公开样例）同样兼容', () => {
    const results = parseBochaResults({ webPages: { value: [{ name: 'T', url: 'https://a.com' }] } });
    expect(results).toEqual([{ title: 'T', url: 'https://a.com', snippet: '' }]);
  });

  it('formatBochaSearchResults 输出编号、URL、来源与日期', () => {
    const text = formatBochaSearchResults([
      { title: 'T1', url: 'https://a.com', snippet: 's', siteName: 'SiteA', publishedAt: '2026-08-10T00:00:00Z' },
    ]);
    expect(text).toContain('1. T1');
    expect(text).toContain('https://a.com');
    expect(text).toContain('来源：SiteA');
    expect(text).toContain('时间：2026-08-10');
    expect(formatBochaSearchResults([])).toBe('没有找到相关网页');
  });
});
