import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { chunkDocument, parseDocument, type Chunk, type ParsedDocument } from '@kunqing/knowledge-core';
import { KnowledgeRepository } from '@kunqing/database';
import { isBuiltinToolEnabled } from './builtin-tool-catalog';
import { LocalOcrService } from './local-ocr';
import { getEnterpriseProjectRoot, getEnterpriseWorkspaceRoot, getProjectRoot } from './paths';

export const STANDARDIZED_DIRECTORY = 'standardized-files';
export const STANDARDIZED_PAGE_SIZE = 8_000;

export type AuthorizedKnowledgeScope = {
  scopeType: 'project' | 'shared';
  scopeId: string;
  workspaceType: 'group' | 'enterprise-project' | 'enterprise';
};

type StandardizedPage = {
  pageNumber: number;
  startOffset: number;
  endOffset: number;
  kind: 'source' | 'logical';
};

export type StandardizedManifest = {
  schemaVersion: 1;
  sourceId: string;
  fileName: string;
  mimeType: string;
  parserId: string;
  contentSha256: string;
  characterCount: number;
  generatedAt: string;
  pages: StandardizedPage[];
  chunks: Array<{
    ordinal: number;
    relativePath: string;
    startOffset: number;
    endOffset: number;
    pageNumber: number;
    sectionPath?: string;
    contentHash: string;
  }>;
};

type ResolvedSource = {
  sourceId: string;
  fileId: string;
  fileName: string;
  normalizedPath: string;
  scopeType: 'project' | 'shared';
  scopeId: string;
  workspaceType: AuthorizedKnowledgeScope['workspaceType'];
};

function workspaceRoot(db: Database.Database, scopeType: 'project' | 'shared', scopeId: string): string {
  if (scopeType === 'shared') return getEnterpriseWorkspaceRoot();
  try {
    if (db.prepare('SELECT 1 FROM enterprise_projects WHERE id = ?').get(scopeId)) {
      return getEnterpriseProjectRoot(scopeId);
    }
  } catch { /* legacy workspace without enterprise_projects */ }
  return getProjectRoot(scopeId);
}

function sourceDirectory(db: Database.Database, scopeType: 'project' | 'shared', scopeId: string, sourceId: string): string {
  if (!/^[a-z0-9_-]{1,128}$/i.test(sourceId)) throw new Error('知识来源标识不合法');
  return join(workspaceRoot(db, scopeType, scopeId), STANDARDIZED_DIRECTORY, sourceId);
}

function pagesFor(document: ParsedDocument): StandardizedPage[] {
  const offsets = document.metadata.pageOffsets
    ?.filter((value, index, values) => Number.isInteger(value) && value >= 0 && value < document.text.length && (index === 0 || value > values[index - 1]!));
  if (offsets?.length) {
    const starts = offsets[0] === 0 ? offsets : [0, ...offsets];
    return starts.map((startOffset, index) => ({
      pageNumber: index + 1,
      startOffset,
      endOffset: starts[index + 1] ?? document.text.length,
      kind: 'source',
    }));
  }
  const pages: StandardizedPage[] = [];
  for (let startOffset = 0; startOffset < document.text.length; startOffset += STANDARDIZED_PAGE_SIZE) {
    pages.push({
      pageNumber: pages.length + 1,
      startOffset,
      endOffset: Math.min(document.text.length, startOffset + STANDARDIZED_PAGE_SIZE),
      kind: 'logical',
    });
  }
  return pages;
}

function locationFor(chunk: Chunk): { startOffset: number; endOffset: number; pageNumber: number; sectionPath?: string } {
  let location: Record<string, unknown> = {};
  try { location = chunk.locationJson ? JSON.parse(chunk.locationJson) as Record<string, unknown> : {}; } catch { /* ignore malformed legacy location */ }
  const startOffset = chunk.startOffset ?? (typeof location.startOffset === 'number' ? location.startOffset : 0);
  const endOffset = chunk.endOffset ?? (typeof location.endOffset === 'number' ? location.endOffset : startOffset + chunk.text.length);
  const pageNumber = chunk.pageNumber ?? (typeof location.pageNumber === 'number' ? location.pageNumber : 1);
  const sectionPath = chunk.sectionPath ?? (typeof location.sectionPath === 'string' ? location.sectionPath : undefined);
  return { startOffset, endOffset, pageNumber, ...(sectionPath ? { sectionPath } : {}) };
}

export async function materializeStandardizedDocument(input: {
  db: Database.Database;
  sourceId: string;
  scopeType: 'project' | 'shared';
  scopeId: string;
  document: ParsedDocument;
  chunks: Chunk[];
}): Promise<StandardizedManifest> {
  const root = sourceDirectory(input.db, input.scopeType, input.scopeId, input.sourceId);
  const chunkRoot = join(root, 'chunks');
  await rm(root, { recursive: true, force: true });
  await mkdir(chunkRoot, { recursive: true });

  const chunkEntries = input.chunks.map((chunk) => {
    const location = locationFor(chunk);
    return {
      ordinal: chunk.ordinal,
      relativePath: `chunks/${String(chunk.ordinal + 1).padStart(6, '0')}.md`,
      ...location,
      contentHash: chunk.contentHash,
    };
  });
  const manifest: StandardizedManifest = {
    schemaVersion: 1,
    sourceId: input.sourceId,
    fileName: String(input.document.metadata.fileName ?? 'document'),
    mimeType: input.document.mimeType,
    parserId: String(input.document.metadata.parserId ?? 'unknown'),
    contentSha256: createHash('sha256').update(input.document.text).digest('hex'),
    characterCount: input.document.text.length,
    generatedAt: new Date().toISOString(),
    pages: pagesFor(input.document),
    chunks: chunkEntries,
  };

  await Promise.all([
    writeFile(join(root, 'document.md'), input.document.text, 'utf8'),
    ...input.chunks.map((chunk, index) => {
      const entry = chunkEntries[index]!;
      const metadata = JSON.stringify({
        sourceId: input.sourceId,
        ordinal: entry.ordinal,
        startOffset: entry.startOffset,
        endOffset: entry.endOffset,
        pageNumber: entry.pageNumber,
        ...(entry.sectionPath ? { sectionPath: entry.sectionPath } : {}),
      });
      return writeFile(join(root, entry.relativePath), `<!-- kla-chunk ${metadata} -->\n\n${chunk.text}\n`, 'utf8');
    }),
  ]);
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

export async function reuseStandardizedDocument(input: {
  db: Database.Database;
  reusableSourceId: string;
  targetSourceId: string;
  targetScopeType: 'project' | 'shared';
  targetScopeId: string;
}): Promise<boolean> {
  const reusable = new KnowledgeRepository(input.db).getSource(input.reusableSourceId);
  if (!reusable) return false;
  const reusableRoot = sourceDirectory(input.db, reusable.scopeType as 'project' | 'shared', reusable.scopeId, reusable.id);
  try { await access(join(reusableRoot, 'document.md')); } catch { return false; }
  const text = await readFile(join(reusableRoot, 'document.md'), 'utf8');
  const oldManifest = JSON.parse(await readFile(join(reusableRoot, 'manifest.json'), 'utf8')) as StandardizedManifest;
  const chunks = new KnowledgeRepository(input.db).listChunks(input.targetSourceId).map((row): Chunk => {
    let location: Record<string, unknown> = {};
    try { location = row.locationJson ? JSON.parse(row.locationJson) as Record<string, unknown> : {}; } catch { /* ignore */ }
    return {
      id: row.id,
      ordinal: row.ordinal,
      text: row.text,
      contentHash: row.contentHash,
      ...(row.locationJson ? { locationJson: row.locationJson } : {}),
      ...(typeof location.startOffset === 'number' ? { startOffset: location.startOffset } : {}),
      ...(typeof location.endOffset === 'number' ? { endOffset: location.endOffset } : {}),
      ...(typeof location.pageNumber === 'number' ? { pageNumber: location.pageNumber } : {}),
      ...(typeof location.sectionPath === 'string' ? { sectionPath: location.sectionPath } : {}),
    };
  });
  await materializeStandardizedDocument({
    db: input.db,
    sourceId: input.targetSourceId,
    scopeType: input.targetScopeType,
    scopeId: input.targetScopeId,
    document: {
      text,
      mimeType: oldManifest.mimeType,
      metadata: { fileName: oldManifest.fileName, parserId: oldManifest.parserId },
    },
    chunks,
  });
  return true;
}

function originalFilePath(db: Database.Database, source: ResolvedSource): string {
  const root = resolve(workspaceRoot(db, source.scopeType, source.scopeId), 'original-files');
  const target = resolve(root, source.normalizedPath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('原始文件路径超出授权工作区');
  return target;
}

async function ensureStandardizedDocument(db: Database.Database, source: ResolvedSource): Promise<void> {
  const root = sourceDirectory(db, source.scopeType, source.scopeId, source.sourceId);
  try {
    await Promise.all([access(join(root, 'document.md')), access(join(root, 'manifest.json'))]);
    return;
  } catch { /* lazily backfill sources processed before standardized files existed */ }

  const filePath = originalFilePath(db, source);
  const buffer = await readFile(filePath);
  const extension = source.fileName.includes('.') ? source.fileName.split('.').pop() ?? '' : '';
  const document = await parseDocument(buffer, extension, source.fileName);
  if (document.metadata.requiresOcr) {
    if (!isBuiltinToolEnabled(db, 'tool.paddle-ocr')) throw new Error('该文件需要 OCR，但本地 OCR 工具当前不可用');
    const text = await new LocalOcrService().extract(filePath);
    if (text.trim()) document.text = text.trim();
  }
  if (!document.text.trim()) throw new Error('文件未能解析出可读取正文');
  const chunks = chunkDocument(document);
  await materializeStandardizedDocument({
    db,
    sourceId: source.sourceId,
    scopeType: source.scopeType,
    scopeId: source.scopeId,
    document,
    chunks,
  });
}

function resolveSource(
  db: Database.Database,
  selector: string,
  scopes: AuthorizedKnowledgeScope[],
): { source?: ResolvedSource; alternatives: ResolvedSource[] } {
  const scopedSql = scopes.map(() => '(s.scope_type = ? AND s.scope_id = ?)').join(' OR ');
  if (!scopedSql) return { alternatives: [] };
  const rows = db.prepare(
    `SELECT s.id as sourceId, s.file_id as fileId, s.scope_type as scopeType, s.scope_id as scopeId,
            f.name as fileName, f.normalized_path as normalizedPath
     FROM knowledge_sources s JOIN files f ON f.id = s.file_id
     WHERE s.status = 'ready' AND (${scopedSql})
     ORDER BY s.ingested_at DESC`,
  ).all(...scopes.flatMap((scope) => [scope.scopeType, scope.scopeId])) as Array<Omit<ResolvedSource, 'workspaceType'>>;
  const normalized = selector.trim().replaceAll('\\', '/').toLocaleLowerCase('zh-CN');
  const ranked = rows.map((row) => {
    const scopeIndex = scopes.findIndex((scope) => scope.scopeType === row.scopeType && scope.scopeId === row.scopeId);
    const values = [row.sourceId, row.fileId, row.normalizedPath, row.fileName].map((value) => value.toLocaleLowerCase('zh-CN'));
    const exactIndex = values.findIndex((value) => value === normalized);
    const suffix = row.normalizedPath.toLocaleLowerCase('zh-CN').endsWith(normalized);
    const contains = values.some((value) => value.includes(normalized));
    const score = exactIndex >= 0 ? 100 - exactIndex : suffix ? 70 : contains ? 40 : 0;
    return { ...row, workspaceType: scopes[scopeIndex]?.workspaceType ?? 'group', score, scopeIndex: scopeIndex < 0 ? 99 : scopeIndex };
  }).filter((row) => row.score > 0).sort((left, right) => right.score - left.score || left.scopeIndex - right.scopeIndex);
  if (!ranked[0]) return { alternatives: [] };
  const source: ResolvedSource = ranked[0];
  const alternatives = ranked.slice(1, 6).map((row): ResolvedSource => row);
  return { source, alternatives };
}

export async function readStandardizedDocument(input: {
  db: Database.Database;
  selector: string;
  scopes: AuthorizedKnowledgeScope[];
  cursor?: number;
  page?: number;
  maxChars?: number;
}): Promise<string> {
  const resolved = resolveSource(input.db, input.selector, input.scopes);
  if (!resolved.source) return `未找到已知识化且有权读取的文件：${input.selector}`;
  const source = resolved.source;
  await ensureStandardizedDocument(input.db, source);
  const root = sourceDirectory(input.db, source.scopeType, source.scopeId, source.sourceId);
  const [text, manifestText] = await Promise.all([
    readFile(join(root, 'document.md'), 'utf8'),
    readFile(join(root, 'manifest.json'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText) as StandardizedManifest;
  const maxChars = Math.max(1_000, Math.min(Math.floor(input.maxChars ?? 6_000), 10_000));
  const requestedPage = input.page === undefined ? undefined : Math.max(1, Math.floor(input.page));
  const page = requestedPage ? manifest.pages[requestedPage - 1] : undefined;
  if (requestedPage && !page) return `页码超出范围：${source.fileName} 共 ${manifest.pages.length} 页，无法读取第 ${requestedPage} 页。`;
  const startOffset = page?.startOffset ?? Math.max(0, Math.min(Math.floor(input.cursor ?? 0), text.length));
  const rangeEnd = page?.endOffset ?? text.length;
  const endOffset = Math.min(rangeEnd, startOffset + maxChars);
  const complete = endOffset >= text.length;
  const pageComplete = !page || endOffset >= page.endOffset;
  const activeChunks = manifest.chunks.filter((chunk) => chunk.endOffset > startOffset && chunk.startOffset < endOffset);
  const sections = [...new Set(activeChunks.map((chunk) => chunk.sectionPath).filter((value): value is string => Boolean(value)))];
  const workspace = source.workspaceType === 'enterprise-project' ? '项目工作区' : source.workspaceType === 'enterprise' ? '企业工作区' : '群聊个人工作区';
  const alternativeNote = resolved.alternatives.length > 0
    ? `\n同名或近似文件：${resolved.alternatives.map((item) => `${item.fileName}（${item.normalizedPath}）`).join('；')}`
    : '';
  return [
    `文件：${source.fileName}`,
    `来源：${workspace} / ${source.normalizedPath}`,
    `sourceId：${source.sourceId}`,
    `读取范围：[${startOffset}, ${endOffset}) / ${text.length} 字符`,
    `标准化页：${page?.pageNumber ?? manifest.pages.find((item) => item.startOffset <= startOffset && item.endOffset > startOffset)?.pageNumber ?? 1}/${manifest.pages.length}${page ? `（本页${pageComplete ? '已读完' : '未读完'}）` : ''}`,
    `章节：${sections.join(' / ') || '未识别章节'}`,
    `READ_COMPLETE: ${complete}`,
    `NEXT_CURSOR: ${complete ? 'NONE' : endOffset}`,
    alternativeNote.trim(),
    '--- 正文 ---',
    text.slice(startOffset, endOffset),
    complete ? '--- 文件已完整覆盖 ---' : `--- 仍有未读正文；下一次使用 cursor=${endOffset} 继续，直至状态显示已完整覆盖 ---`,
  ].filter(Boolean).join('\n');
}
