// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
  app: { getPath: vi.fn(() => '/mock/app/path') },
}));

import Database from 'better-sqlite3';
import { ensureBochaApiKey, formatBochaSearchResults, searchBochaWeb } from './bocha-web-search';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE secrets (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ciphertext BLOB NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
  return db;
}

describe('Bocha web search', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.BOCHA_API_KEY;
  });

  it('stores the bootstrap key encrypted and parses web pages', async () => {
    const db = createDb();
    process.env.BOCHA_API_KEY = 'test-key';
    expect(ensureBochaApiKey(db)).toBe(true);
    expect((db.prepare('SELECT ciphertext FROM secrets').get() as { ciphertext: Buffer }).ciphertext.toString()).toBe('test-key');

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      data: { webPages: { value: [{ name: 'Example', url: 'https://example.com', snippet: 'A result', siteName: 'Example', datePublished: '2026-08-10T00:00:00Z' }] } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const results = await searchBochaWeb(db, { query: 'example', count: 1 });
    expect(fetchMock).toHaveBeenCalledWith('https://api.bocha.cn/v1/web-search', expect.objectContaining({ method: 'POST' }));
    expect(results[0]).toMatchObject({ title: 'Example', url: 'https://example.com', siteName: 'Example' });
    expect(formatBochaSearchResults(results)).toContain('https://example.com');

    await searchBochaWeb(db, { query: 'example', include: ['example.com', 'www.example.com'] });
    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ include: 'example.com,www.example.com' });
  });

  it('throws a clear error when no API key has been configured', async () => {
    const db = createDb();
    expect(ensureBochaApiKey(db)).toBe(false);
    await expect(searchBochaWeb(db, { query: 'anything' })).rejects.toThrow(/未配置 API Key/);
  });

  it('keeps an existing saved key ahead of environment and built-in defaults', () => {
    const db = createDb();
    process.env.BOCHA_API_KEY = 'first-key';
    expect(ensureBochaApiKey(db)).toBe(true);
    process.env.BOCHA_API_KEY = 'replacement-key';
    expect(ensureBochaApiKey(db)).toBe(true);
    expect((db.prepare('SELECT ciphertext FROM secrets').get() as { ciphertext: Buffer }).ciphertext.toString()).toBe('first-key');
  });

  it('only returns researcher access through ToolRegistry permissions', async () => {
    const db = createDb();
    const { ToolRegistry } = await import('./tool-registry');
    const registry = new ToolRegistry(db);
    registry.register({
      name: 'web:search',
      description: 'test',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      requiredCapabilities: ['network:search'],
      execute: async () => 'ok',
    });
    expect(registry.canRoleUseTool('researcher', 'web:search')).toBe(true);
    expect(registry.canRoleUseTool('orchestrator', 'web:search')).toBe(false);
    expect(registry.canRoleUseTool('knowledge-manager', 'web:search')).toBe(false);
  });
});
