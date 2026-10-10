import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { findReadableLibraryByDocId } from '../auth/knowledge-libraries.js';

/**
 * 读取授权的反查：docId → 所属库 → 该库是否可读。
 * 用真实 PG schema 验证，避免 mock 掩盖 SQL 写错（字段名/表名拼错时 mock 仍会「通过」）。
 */
const identityId = '00000000-0000-4000-8000-0000000000a1';
const otherIdentity = '00000000-0000-4000-8000-0000000000a2';
const orgA = '00000000-0000-4000-8000-0000000000b1';
const libraryA = '00000000-0000-4000-8000-0000000000c1';
const docInA = 'doc-in-library-a';
const docNoOwner = 'doc-without-library';

async function withDb<T>(work: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  const schema = 'kla_acltest_' + Math.random().toString(16).slice(2, 12);
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    await client.query(`SET search_path TO "${schema}", public`);
    await client.query('CREATE TABLE identities (id uuid PRIMARY KEY, type text NOT NULL, organization_id uuid, status text NOT NULL)');
    await client.query('CREATE TABLE organizations (id uuid PRIMARY KEY, name text NOT NULL, status text NOT NULL)');
    await client.query('CREATE TABLE projects (id uuid PRIMARY KEY, owner_identity_id uuid NOT NULL, organization_id uuid)');
    await client.query('CREATE TABLE project_members (project_id uuid, identity_id uuid, role text NOT NULL)');
    await client.query('CREATE TABLE knowledge_bases (id uuid PRIMARY KEY, name text NOT NULL, description text NOT NULL DEFAULT \'\', collection text NOT NULL, scope text NOT NULL, organization_id uuid, project_id uuid, owner_identity_id uuid, created_by_identity_id uuid NOT NULL, status text NOT NULL DEFAULT \'active\', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())');
    await client.query('CREATE TABLE knowledge_documents (doc_id text PRIMARY KEY, knowledge_base_id uuid REFERENCES knowledge_bases(id))');
    await client.query('INSERT INTO organizations VALUES ($1, \'甲企业\', \'active\')', [orgA]);
    await client.query('INSERT INTO identities VALUES ($1, \'enterprise\', $2, \'active\')', [identityId, orgA]);
    await client.query('INSERT INTO identities VALUES ($1, \'enterprise\', \'00000000-0000-4000-8000-0000000000b9\', \'active\')', [otherIdentity]);
    await client.query('INSERT INTO knowledge_bases (id, name, collection, scope, organization_id, created_by_identity_id) VALUES ($1, \'甲公司库\', \'金牌知识库\', \'company\', $2, $1)', [libraryA, orgA]);
    await client.query('INSERT INTO knowledge_documents VALUES ($1, $2)', [docInA, libraryA]);
    await client.query('INSERT INTO knowledge_documents VALUES ($1, NULL)', [docNoOwner]);
    client.release();
    const scoped = new pg.Pool({ connectionString: url, max: 2, options: `-c search_path=${schema},public` });
    try { return await work(scoped); } finally { await scoped.end(); }
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await pool.end();
  }
}

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe('findReadableLibraryByDocId', () => {
  it('文档属于可读库时返回该库（含归属 scope）', async () => {
    if (!hasDatabase) return;
    await withDb(async pool => {
      const found = await findReadableLibraryByDocId(pool, identityId, docInA);
      expect(found?.entry.id).toBe(libraryA);
      expect(found?.entry.collection).toBe('金牌知识库');
      expect(found?.scope.organizationId).toBe(orgA);
    });
  });

  it('同组织的企业身份可读（公司库按组织共享）', async () => {
    if (!hasDatabase) return;
    await withDb(async pool => {
      const peer = await pool.connect();
      await peer.query(`INSERT INTO identities VALUES ('00000000-0000-4000-8000-0000000000a3', 'enterprise', '${orgA}', 'active')`);
      peer.release();
      const found = await findReadableLibraryByDocId(pool, '00000000-0000-4000-8000-0000000000a3', docInA);
      expect(found?.entry.id).toBe(libraryA);
    });
  });

  it('其他组织的身份读不到 → 拒绝（fail-closed）', async () => {
    if (!hasDatabase) return;
    await withDb(async pool => {
      expect(await findReadableLibraryByDocId(pool, otherIdentity, docInA)).toBeNull();
    });
  });

  it('文档无归属记录 → 拒绝（不因查不到就放行）', async () => {
    if (!hasDatabase) return;
    await withDb(async pool => {
      expect(await findReadableLibraryByDocId(pool, identityId, docNoOwner)).toBeNull();
    });
  });

  it('未知 docId → 拒绝', async () => {
    if (!hasDatabase) return;
    await withDb(async pool => {
      expect(await findReadableLibraryByDocId(pool, identityId, '不存在的文档')).toBeNull();
    });
  });
});
describe('切片响应的契约校验（回归）', () => {
  it('远端返回服务端专有字段时，schema 校验后只剩前端需要的字段', () => {
    const { documentSlicesSchema } = require('@kla-workstation/contracts/knowledge');
    const upstream = {
      doc_id: 'doc-a', source: 'a.mp4', collection: '金牌知识库', count: 1,
      slices: [{ id: 1, title: '标题', content: '正文', group: null }],
      slices_path: '/home/知识库/切片文件/mp4/a.json',   // 服务端专有，不应外泄
      knowledge_base_id: '270a80f5-fb2d-4bbd-ac57-316d257be01e',
      abs_path: '/home/知识库/上传文档/mp4/a.mp4',
    };
    const parsed = documentSlicesSchema.safeParse(upstream);
    expect(parsed.success).toBe(true);
    // 契约 schema 会裁掉未声明的字段
    expect(parsed.success && 'slices_path' in parsed.data).toBe(false);
    expect(parsed.success && 'knowledge_base_id' in parsed.data).toBe(false);
    expect(parsed.success && parsed.data.count).toBe(1);
  });

  it('缺少 count 与 slices 一致性约束时拒绝', () => {
    const { documentSlicesSchema } = require('@kla-workstation/contracts/knowledge');
    const bad = { doc_id: 'doc-a', source: 'a.mp4', collection: '金牌知识库', count: 3, slices: [{ id: 1, title: 't', content: 'c' }] };
    expect(documentSlicesSchema.safeParse(bad).success).toBe(false);
  });
});
