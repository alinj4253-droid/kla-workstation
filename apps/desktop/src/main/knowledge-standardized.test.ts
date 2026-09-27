// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => process.cwd()) },
}));

import Database from 'better-sqlite3';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunkDocument, type ParsedDocument } from '@kunqing/knowledge-core';
import { materializeStandardizedDocument, readStandardizedDocument } from './knowledge-standardized';
import { setStudioRoot } from './paths';

describe('standardized knowledge documents', () => {
  let db: Database.Database;
  let studioRoot: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE enterprise_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE files (id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_path TEXT NOT NULL);
      CREATE TABLE knowledge_sources (
        id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, file_id TEXT NOT NULL,
        status TEXT NOT NULL, ingested_at TEXT
      );
    `);
    studioRoot = await mkdtemp(join(tmpdir(), 'kla-standardized-'));
    setStudioRoot(studioRoot);
  });

  afterEach(async () => {
    db.close();
    setStudioRoot('');
    await rm(studioRoot, { recursive: true, force: true });
  });

  it('persists full text and chunks, then reads every character without gaps', async () => {
    const text = `# 第一章\n\n${'甲'.repeat(7_500)}\n\n# 第二章\n\n${'乙'.repeat(7_500)}`;
    const document: ParsedDocument = {
      text,
      mimeType: 'text/markdown',
      metadata: { fileName: '制度汇编.md', parserId: 'text-decoder' },
    };
    const chunks = chunkDocument(document, { targetSize: 2_000, overlap: 200, minSize: 100 });
    db.prepare("INSERT INTO files VALUES ('file-1', '制度汇编.md', '制度汇编.md')").run();
    db.prepare("INSERT INTO knowledge_sources VALUES ('source-1', 'project', 'group-1', 'file-1', 'ready', '2026-08-26')").run();

    const manifest = await materializeStandardizedDocument({
      db,
      sourceId: 'source-1',
      scopeType: 'project',
      scopeId: 'group-1',
      document,
      chunks,
    });

    const root = join(studioRoot, 'group-chats', 'group-1-workspace', 'standardized-files', 'source-1');
    expect(await readFile(join(root, 'document.md'), 'utf8')).toBe(text);
    expect(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))).toMatchObject({
      sourceId: 'source-1',
      characterCount: text.length,
    });
    expect(manifest.pages.length).toBeGreaterThan(1);
    expect(manifest.chunks[0]).toMatchObject({ startOffset: 0, pageNumber: 1, sectionPath: '第一章' });
    expect(await readFile(join(root, manifest.chunks[0]!.relativePath), 'utf8')).toContain(chunks[0]!.text);

    let cursor = 0;
    let reconstructed = '';
    for (let index = 0; index < 10; index++) {
      const output = await readStandardizedDocument({
        db,
        selector: '制度汇编.md',
        scopes: [{ scopeType: 'project', scopeId: 'group-1', workspaceType: 'group' }],
        cursor,
        maxChars: 4_000,
      });
      const body = output.match(/--- 正文 ---\n([\s\S]*?)\n--- (?:仍有未读正文|文件已完整覆盖)/)?.[1] ?? '';
      reconstructed += body;
      const next = output.match(/NEXT_CURSOR: (\d+)/)?.[1];
      if (output.includes('READ_COMPLETE: true')) break;
      expect(next).toBeTruthy();
      cursor = Number(next);
    }
    expect(reconstructed).toBe(text);
  });

  it('supports deterministic pages and rejects sources outside the authorized scopes', async () => {
    const text = 'A'.repeat(9_000);
    const document: ParsedDocument = { text, mimeType: 'text/plain', metadata: { fileName: 'full.txt', parserId: 'text-decoder' } };
    db.prepare("INSERT INTO files VALUES ('file-2', 'full.txt', 'full.txt')").run();
    db.prepare("INSERT INTO knowledge_sources VALUES ('source-2', 'project', 'group-2', 'file-2', 'ready', '2026-08-26')").run();
    await materializeStandardizedDocument({
      db,
      sourceId: 'source-2',
      scopeType: 'project',
      scopeId: 'group-2',
      document,
      chunks: chunkDocument(document),
    });

    const pageTwo = await readStandardizedDocument({
      db,
      selector: 'source-2',
      scopes: [{ scopeType: 'project', scopeId: 'group-2', workspaceType: 'group' }],
      page: 2,
    });
    expect(pageTwo).toContain('读取范围：[8000, 9000)');
    expect(pageTwo).toContain('READ_COMPLETE: true');

    const denied = await readStandardizedDocument({
      db,
      selector: 'source-2',
      scopes: [{ scopeType: 'project', scopeId: 'group-1', workspaceType: 'group' }],
    });
    expect(denied).toContain('未找到已知识化且有权读取的文件');
  });
});
