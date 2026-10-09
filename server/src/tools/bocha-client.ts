// 博查 Web Search 客户端（工具类计费项的第一个上游适配层）。
//
// 移植自旧版 chat 分支 apps/desktop/src/main/bocha-web-search.ts，剥离 electron / better-sqlite3 依赖。
// 实测契约见 docs/DESIGN_BOCHA_SEARCH_INTEGRATION.md §2、§2.1（优先级高于公开文档）：
// - 端点 POST https://api.bocha.cn/v1/web-search，Bearer 鉴权
// - 响应为 { msg?, data } 信封，结果在 data.webPages.value[]（公开样例的顶层 webPages 写法不可照抄）
// - 错误详情取 msg 字段；401 = Key 无效/无接口权限；403 = 平台余额不足
//
// 本层只做协议适配，不注入业务语义：判权、计费、记账由 tool-service 负责（P1-11 落地后接入）。

const DEFAULT_ENDPOINT = 'https://api.bocha.cn/v1/web-search';
const DEFAULT_COUNT = 5;
const MAX_COUNT = 20;
const MAX_SITE_FILTERS = 20;

export const BOCHA_WEB_SEARCH_TOOL_ID = 'bocha-web-search';

export type BochaSearchInput = {
  query: string;
  /** 结果条数：默认 5，上限 20（旧版口径，官方上限 50 但结果过多稀释 agent 质量） */
  count?: number;
  /** 时间过滤：noLimit | oneDay | oneWeek | oneMonth | oneYear | YYYY-MM-DD | YYYY-MM-DD..YYYY-MM-DD */
  freshness?: string;
  /** 是否返回长文本摘要，默认 true（tool-service 层固定 true，不暴露给前端） */
  summary?: boolean;
  /** 限定站点/域名：数组或逗号分隔字符串，最多 20 个（旧版实测可用） */
  include?: string | string[];
  /** 排除站点/域名：数组或逗号分隔字符串，最多 20 个（旧版实测可用） */
  exclude?: string | string[];
};

export type BochaSearchResult = {
  title: string;
  url: string;
  snippet: string;
  summary?: string;
  siteName?: string;
  publishedAt?: string;
};

/** 失败分类；route 层据此映射到契约 ErrorCode（§2 错误码表）。 */
export type BochaFailureKind =
  | 'invalid_argument'   // 400 或空 query：不重试
  | 'unauthorized'       // 401：Key 无效或无接口调用权限；配置问题，需告警
  | 'upstream_exhausted' // 403：博查平台余额不足；需告警充值
  | 'rate_limited'       // 429：上游限流；已自动退避重试 1 次
  | 'upstream_error'     // 5xx、网络错误或响应不符合契约；网络/5xx 已重试 1 次
  | 'timeout';           // 请求超时：不重试

export class BochaClientError extends Error {
  constructor(
    public readonly kind: BochaFailureKind,
    message: string,
    public readonly httpStatus: number | null = null,
    public readonly upstreamMessage: string | null = null,
  ) {
    super(message);
    this.name = 'BochaClientError';
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** 兼容两种响应形态：实测的 { data: { webPages } } 信封与公开样例的顶层 webPages。 */
function extractWebPages(payload: unknown): unknown[] {
  const root = payload as { data?: { webPages?: { value?: unknown } }; webPages?: { value?: unknown } } | null;
  const value = root?.data?.webPages?.value ?? root?.webPages?.value;
  return Array.isArray(value) ? value : [];
}

function extractMsg(payload: unknown): string | null {
  const msg = (payload as { msg?: unknown } | null)?.msg;
  return typeof msg === 'string' && msg.trim() ? msg.trim() : null;
}

/** 字段裁剪与空值防御（移植自旧版 parseResults）。 */
export function parseBochaResults(payload: unknown): BochaSearchResult[] {
  return extractWebPages(payload).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const page = item as Record<string, unknown>;
    const url = typeof page.url === 'string' ? page.url.trim() : '';
    const title = typeof page.name === 'string' ? page.name.trim() : '';
    if (!url || !title) return [];
    return [{
      title,
      url,
      snippet: typeof page.snippet === 'string' ? page.snippet.trim() : '',
      ...(typeof page.summary === 'string' && page.summary.trim() ? { summary: page.summary.trim() } : {}),
      ...(typeof page.siteName === 'string' && page.siteName.trim() ? { siteName: page.siteName.trim() } : {}),
      ...(typeof page.datePublished === 'string' && page.datePublished.trim() ? { publishedAt: page.datePublished } : {}),
    }];
  });
}

/** 站点过滤归一：数组/逗号串统一为去重后的逗号分隔字符串并截断（旧版为直接透传，此处略作加固）。 */
function normalizeSiteFilter(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  const joined = Array.isArray(value) ? value.join(',') : value;
  const parts = Array.from(new Set(joined.split(',').map((item) => item.trim()).filter(Boolean))).slice(0, MAX_SITE_FILTERS);
  return parts.length ? parts.join(',') : undefined;
}

function mapHttpFailure(status: number, raw: string): BochaClientError {
  const payload = tryParseJson(raw);
  const upstream = extractMsg(payload);
  const detail = upstream ?? raw.slice(0, 200);
  switch (status) {
    case 400:
      return new BochaClientError('invalid_argument', `博查搜索失败：${detail}`, status, upstream);
    case 401:
      return new BochaClientError('unauthorized', '博查搜索鉴权失败：API Key 无效或无接口调用权限', status, upstream);
    case 403:
      return new BochaClientError('upstream_exhausted', '博查搜索余额不足，请为平台账户充值', status, upstream);
    case 429:
      return new BochaClientError('rate_limited', '博查搜索限流，请稍后重试', status, upstream);
    default:
      return new BochaClientError('upstream_error', `博查搜索失败（HTTP ${status}）：${detail}`, status, upstream);
  }
}

export type BochaClientOptions = {
  /** 平台统一的博查 API Key（服务端持有，绝不下发客户端，§4 Key 管理） */
  apiKey: string;
  endpoint?: string;
  /** 单次请求超时，默认 10s（§8；旧版为 30s 可参考） */
  timeoutMs?: number;
  /** 429/5xx 重试退避，默认 500ms */
  retryDelayMs?: number;
  fetchImpl?: FetchLike;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createBochaClient(options: BochaClientOptions) {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const doFetch = options.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));

  async function searchWeb(input: BochaSearchInput): Promise<BochaSearchResult[]> {
    const query = input.query.trim();
    if (!query) throw new BochaClientError('invalid_argument', '请输入要搜索的内容');
    const apiKey = options.apiKey.trim();
    if (!apiKey) throw new BochaClientError('unauthorized', '博查搜索未配置 API Key（BOCHA_API_KEY）');

    const body: Record<string, unknown> = {
      query,
      count: Math.max(1, Math.min(MAX_COUNT, Math.round(input.count ?? DEFAULT_COUNT))),
      freshness: input.freshness ?? 'noLimit',
      summary: input.summary ?? true,
    };
    const include = normalizeSiteFilter(input.include);
    const exclude = normalizeSiteFilter(input.exclude);
    if (include) body.include = include;
    if (exclude) body.exclude = exclude;

    let lastError: BochaClientError | null = null;
    // §8：仅 429/5xx 与网络错误退避重试 1 次；400/401/403 与超时不重试
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await sleep(retryDelayMs);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let raw = '';
      let status: number;
      try {
        const response = await doFetch(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        raw = await response.text();
        status = response.status;
      } catch (error) {
        clearTimeout(timer);
        const aborted = error instanceof Error && error.name === 'AbortError';
        if (aborted) {
          throw new BochaClientError('timeout', '博查搜索请求超时');
        }
        lastError = new BochaClientError('upstream_error', `博查搜索请求失败：${error instanceof Error ? error.message : String(error)}`);
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (status === 429 || status >= 500) {
        lastError = mapHttpFailure(status, raw);
        continue;
      }
      if (status < 200 || status >= 300) throw mapHttpFailure(status, raw);

      const payload = tryParseJson(raw);
      if (payload === null) {
        throw new BochaClientError('upstream_error', `博查搜索响应不是合法 JSON：${raw.slice(0, 200)}`, status);
      }
      const results = parseBochaResults(payload);
      if (!results.length) {
        // 旧版语义：200 但无结果且带 msg 时按失败处理
        const upstream = extractMsg(payload);
        if (upstream) throw new BochaClientError('upstream_error', `博查搜索失败：${upstream}`, status, upstream);
      }
      return results;
    }
    throw lastError ?? new BochaClientError('upstream_error', '博查搜索失败');
  }

  return { searchWeb };
}

export type BochaClient = ReturnType<typeof createBochaClient>;

/** 给 agent 的文本格式（移植自旧版 formatBochaSearchResults，编号+标题+URL+来源+日期+摘要）。 */
export function formatBochaSearchResults(results: BochaSearchResult[]): string {
  if (!results.length) return '没有找到相关网页';
  return results.map((item, index) => {
    const source = item.siteName ? ` | 来源：${item.siteName}` : '';
    const date = item.publishedAt ? ` | 时间：${item.publishedAt.slice(0, 10)}` : '';
    const detail = item.summary || item.snippet;
    return `${index + 1}. ${item.title}\n${item.url}${source}${date}\n${detail}`;
  }).join('\n\n');
}
