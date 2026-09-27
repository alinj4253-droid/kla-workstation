// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => process.cwd()), getAppPath: vi.fn(() => process.cwd()) },
}));
vi.mock('./knowledge-artifacts', () => ({ materializeKnowledgeArtifacts: vi.fn(async () => undefined) }));

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRepository, KnowledgeRepository } from '@kunqing/database';
import { ingestKnowledgeFile } from './knowledge-ingestion';
import type { ModelGateway } from './model-gateway';
import { setStudioRoot } from './paths';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE files (
      id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, parent_id TEXT, type TEXT NOT NULL,
      name TEXT NOT NULL, normalized_path TEXT NOT NULL, mime_type TEXT, current_version_id TEXT, origin TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE UNIQUE INDEX idx_files_scope_path ON files(scope_type, scope_id, normalized_path);
    CREATE TABLE file_versions (
      id TEXT PRIMARY KEY, file_id TEXT NOT NULL, version_no INTEGER NOT NULL, storage_rel_path TEXT NOT NULL,
      size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_by_type TEXT NOT NULL, created_by_id TEXT NOT NULL,
      run_id TEXT, change_note TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_sources (
      id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, file_id TEXT NOT NULL, version_id TEXT,
      sha256 TEXT, content_md5 TEXT, parser_id TEXT, metadata_json TEXT, status TEXT NOT NULL, ingested_at TEXT
    );
    CREATE TABLE knowledge_ingestion_jobs (
      id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, source_id TEXT NOT NULL, status TEXT NOT NULL,
      stage TEXT, progress INTEGER, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_chunks (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, ordinal INTEGER NOT NULL, text TEXT NOT NULL,
      location_json TEXT, content_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX unq_knowledge_chunks_source_ordinal ON knowledge_chunks(source_id, ordinal);
    CREATE TABLE knowledge_document_profiles (
      source_id TEXT PRIMARY KEY, summary TEXT NOT NULL, keywords_json TEXT NOT NULL, tags_json TEXT NOT NULL,
      language TEXT NOT NULL, metadata_json TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_chunk_embeddings (
      chunk_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, model_id TEXT NOT NULL, dimensions INTEGER NOT NULL,
      vector_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_nodes (
      id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, node_type TEXT NOT NULL,
      canonical_name TEXT NOT NULL, summary TEXT, properties_json TEXT, confidence REAL NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_edges (
      id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, source_node_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL, edge_type TEXT NOT NULL, properties_json TEXT, confidence REAL NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_provenance (
      id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL, source_id TEXT, chunk_id TEXT,
      location_json TEXT, quote_hash TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE wiki_pages (
      id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL,
      body_md TEXT, source_refs_json TEXT, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX unq_wiki_pages_scope_slug ON wiki_pages(scope_type, scope_id, slug);
    CREATE TABLE enterprise_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  `);
  return db;
}

describe('cross-workspace MD5 knowledge reuse', () => {
  let db: Database.Database;
  let studioRoot: string;

  beforeEach(async () => {
    db = createDb();
    studioRoot = await mkdtemp(join(tmpdir(), 'kla-md5-reuse-'));
    setStudioRoot(studioRoot);
  });

  afterEach(async () => {
    db.close();
    setStudioRoot('');
    await rm(studioRoot, { recursive: true, force: true });
  });

  it('reuses chunks, embeddings, graph and wiki without invoking the model pipeline', async () => {
    const content = '统一差旅制度：出差前应由直属负责人审批。';
    const buffer = Buffer.from(content);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const md5 = createHash('md5').update(buffer).digest('hex');
    const fileRepo = new FileRepository(db);
    const knowledgeRepo = new KnowledgeRepository(db);

    const personalRoot = join(studioRoot, 'group-chats', 'group-1-workspace', 'original-files');
    await mkdir(personalRoot, { recursive: true });
    await writeFile(join(personalRoot, 'policy.txt'), buffer);
    const personalFile = fileRepo.create({
      scopeType: 'project', scopeId: 'group-1', type: 'file', name: 'policy.txt', normalizedPath: 'policy.txt', origin: 'upload',
    });
    const personalVersion = fileRepo.createVersion({
      fileId: personalFile.id, storageRelPath: '.runtime/versions/policy.txt', size: buffer.byteLength, sha256,
      createdByType: 'user', createdById: 'user',
    });
    const personalSource = knowledgeRepo.createSource({
      scopeType: 'project', scopeId: 'group-1', fileId: personalFile.id, versionId: personalVersion.id, sha256, contentMd5: md5,
    });
    const personalChunk = knowledgeRepo.createChunk({
      sourceId: personalSource.id, ordinal: 0, text: content, contentHash: 'content-hash', locationJson: '{"page":1}',
    });
    knowledgeRepo.upsertDocumentProfile({
      sourceId: personalSource.id, summary: '差旅审批制度', keywords: ['差旅', '审批'], tags: ['制度'], language: 'zh',
    });
    knowledgeRepo.upsertEmbedding({ chunkId: personalChunk.id, sourceId: personalSource.id, modelId: 'local-test', vector: [0.2, 0.8] });
    const node = knowledgeRepo.upsertNode({
      scopeType: 'project', scopeId: 'group-1', nodeType: 'process', canonicalName: '差旅审批', summary: '出差前完成审批', confidence: 0.95,
    });
    knowledgeRepo.createProvenance({
      targetType: 'node', targetId: node.id, sourceId: personalSource.id, chunkId: personalChunk.id, locationJson: '{"page":1}',
    });
    db.prepare(
      'INSERT INTO wiki_pages VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('wiki-1', 'project', 'group-1', 'travel-approval', '差旅审批', '# 差旅审批', JSON.stringify([{ sourceId: personalSource.id, chunkId: personalChunk.id }]), new Date().toISOString());
    knowledgeRepo.setSourceStatus(personalSource.id, 'ready');

    db.prepare("INSERT INTO enterprise_projects VALUES ('enterprise-1', '专项项目')").run();
    const projectRoot = join(studioRoot, 'projects', 'enterprise-1', 'original-files', 'groups', 'group-1');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, 'policy-copy.txt'), buffer);
    const projectFile = fileRepo.create({
      scopeType: 'project', scopeId: 'enterprise-1', parentId: 'groups/group-1', type: 'file',
      name: 'policy-copy.txt', normalizedPath: 'groups/group-1/policy-copy.txt', origin: 'imported',
    });
    fileRepo.createVersion({
      fileId: projectFile.id, storageRelPath: '.runtime/versions/policy-copy.txt', size: buffer.byteLength, sha256,
      createdByType: 'user', createdById: 'user',
    });

    const generateText = vi.fn(() => { throw new Error('MD5 reuse must not call the model'); });
    await ingestKnowledgeFile(db, { generateText } as unknown as ModelGateway, projectFile.id);

    const projectSource = knowledgeRepo.getSourceByFile(projectFile.id);
    expect(projectSource).toMatchObject({ status: 'ready', contentMd5: md5, parserId: null });
    expect(knowledgeRepo.getLatestJobForSource(projectSource!.id)).toMatchObject({ status: 'completed', stage: 'reused-md5', progress: 100 });
    expect(knowledgeRepo.listChunks(projectSource!.id)).toHaveLength(1);
    expect(knowledgeRepo.listEmbeddings([{ scopeType: 'project', scopeId: 'enterprise-1' }])).toHaveLength(1);
    expect(knowledgeRepo.listNodes('project', 'enterprise-1').map((item) => item.canonicalName)).toContain('差旅审批');
    const projectWiki = db.prepare("SELECT source_refs_json as sourceRefsJson FROM wiki_pages WHERE scope_id = 'enterprise-1'").get() as { sourceRefsJson: string };
    expect(projectWiki.sourceRefsJson).toContain(projectSource!.id);
    expect(projectWiki.sourceRefsJson).not.toContain(personalSource.id);
    expect(generateText).not.toHaveBeenCalled();
  });
});
