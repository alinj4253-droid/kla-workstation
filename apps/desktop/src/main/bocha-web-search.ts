import type Database from 'better-sqlite3';
import { safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';

const BOCHA_ENDPOINT = 'https://api.bocha.cn/v1/web-search';
const BOCHA_SECRET_KIND = 'tool-bocha-web-search';
// 博查搜索不再内嵌生产 API Key。密钥只从加密 secrets 表或 BOCHA_API_KEY 环境变量
// 解析，二者都缺失时接口返回明确的“未配置”状态，而不是回退到写死的密钥。
const DEFAULT_COUNT = 5;
const MAX_COUNT = 20;

export type BochaSearchOptions = {
  query: string;
  count?: number;
  freshness?: 'noLimit' | 'day' | 'week' | 'month' | 'year';
  summary?: boolean;
  include?: string | string[];
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

type SecretRow = { id: string; ciphertext: Buffer | string };

function readApiKey(db: Database.Database): string | null {
  try {
    const row = db.prepare(
      'SELECT id, ciphertext FROM secrets WHERE kind = ? ORDER BY updated_at DESC LIMIT 1',
    ).get(BOCHA_SECRET_KIND) as SecretRow | undefined;
    if (!row || !safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(row.ciphertext as Buffer).trim() || null;
  } catch {
    return null;
  }
}

export function hasBochaApiKey(db: Database.Database): boolean {
  return Boolean(readApiKey(db) || process.env.BOCHA_API_KEY?.trim());
}

/** Bootstrap the effective key into the encrypted local secrets table (env-key only). */
export function ensureBochaApiKey(db: Database.Database): boolean {
  if (readApiKey(db)) {
    delete process.env.BOCHA_API_KEY;
    return true;
  }
  const envKey = process.env.BOCHA_API_KEY?.trim();
  if (!envKey) return false;
  if (!safeStorage.isEncryptionAvailable()) return false;
  try {
    const now = new Date().toISOString();
    const ciphertext = safeStorage.encryptString(envKey);
    db.prepare(
      'INSERT INTO secrets (id, kind, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(`secret-bocha-${randomUUID().slice(0, 8)}`, BOCHA_SECRET_KIND, ciphertext, now, now);
    delete process.env.BOCHA_API_KEY;
    return true;
  } catch {
    return false;
  }
}

function parseResults(payload: unknown): BochaSearchResult[] {
  const pages = (payload as { data?: { webPages?: { value?: unknown[] } } })?.data?.webPages?.value;
  if (!Array.isArray(pages)) return [];
  return pages.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const page = item as Record<string, unknown>;
    const url = typeof page.url === 'string' ? page.url : '';
    const title = typeof page.name === 'string' ? page.name : '';
    if (!url || !title) return [];
    return [{
      title: title.trim(),
      url,
      snippet: typeof page.snippet === 'string' ? page.snippet.trim() : '',
      ...(typeof page.summary === 'string' && page.summary.trim() ? { summary: page.summary.trim() } : {}),
      ...(typeof page.siteName === 'string' && page.siteName.trim() ? { siteName: page.siteName.trim() } : {}),
      ...(typeof page.datePublished === 'string' && page.datePublished.trim() ? { publishedAt: page.datePublished } : {}),
    }];
  });
}

export async function searchBochaWeb(db: Database.Database, options: BochaSearchOptions): Promise<BochaSearchResult[]> {
  const query = options.query.trim();
  if (!query) throw new Error('请输入要搜索的内容');
  const apiKey = readApiKey(db) || process.env.BOCHA_API_KEY?.trim();
  if (!apiKey) throw new Error('博查搜索未配置 API Key。请在环境变量 BOCHA_API_KEY 中配置，或在“设置 → AI 生产力 → 工具”中填写。');
  const count = Math.max(1, Math.min(MAX_COUNT, Math.round(options.count ?? DEFAULT_COUNT)));
  const body: Record<string, unknown> = {
    query,
    count,
    freshness: options.freshness ?? 'noLimit',
    summary: options.summary ?? true,
  };
  if (options.include?.length) body.include = Array.isArray(options.include) ? options.include.slice(0, 20).join(',') : options.include;
  if (options.exclude?.length) body.exclude = Array.isArray(options.exclude) ? options.exclude.slice(0, 20).join(',') : options.exclude;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(BOCHA_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload: unknown = null;
    try { payload = JSON.parse(raw); } catch { /* handled below */ }
    if (!response.ok) {
      const message = (payload as { msg?: unknown })?.msg;
      throw new Error(typeof message === 'string' ? `博查搜索失败：${message}` : `博查搜索失败（HTTP ${response.status}）`);
    }
    const results = parseResults(payload);
    if (!results.length) {
      const message = (payload as { msg?: unknown })?.msg;
      if (typeof message === 'string' && message) throw new Error(`博查搜索失败：${message}`);
    }
    return results;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('博查搜索请求超时', { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function formatBochaSearchResults(results: BochaSearchResult[]): string {
  if (!results.length) return '没有找到相关网页';
  return results.map((item, index) => {
    const source = item.siteName ? ` | 来源：${item.siteName}` : '';
    const date = item.publishedAt ? ` | 时间：${item.publishedAt.slice(0, 10)}` : '';
    const detail = item.summary || item.snippet;
    return `${index + 1}. ${item.title}\n${item.url}${source}${date}\n${detail}`;
  }).join('\n\n');
}

export const bochaWebSearchConfig = { endpoint: BOCHA_ENDPOINT, secretKind: BOCHA_SECRET_KIND } as const;
