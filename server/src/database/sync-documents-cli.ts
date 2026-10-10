import { loadConfig } from '../config.js';
import { PostgresDatabase } from './postgres.js';

/**
 * 把远端知识服务的文档目录回填进 knowledge_documents（幂等，可重复执行）。
 *
 * 背景：文档与切片由远端知识服务持有，本地此前不落库，doc_id 只存在于服务端内存，
 * 权限无处落地。本脚本用两条远端接口补齐本地目录：
 *   1. GET /v1/documents?category=上传文档 —— 列表（**不含 collection**）
 *   2. GET /v1/documents/{docId}/slices     —— 逐个确认所属集合与切片数
 *
 * 未切片 / 不属于任何集合的文档（响应 404 或无 collection）不写入，
 * 因为无法确定归属，写进目录表只会让权限判断出现无集合的孤儿行。
 *
 * 用法：pnpm db:sync-documents        （默认并发 3，避免打爆远端）
 *      CONCURRENCY=6 pnpm db:sync-documents
 */

const config = loadConfig();
const concurrency = Math.max(1, Math.min(8, Number(process.env.CONCURRENCY ?? '3') || 3));
const baseUrl = (process.env.KNOWLEDGE_BASE_URL || '').replace(/\/$/, '') || 'http://192.168.10.206:8120';

interface RemoteDocument {
  doc_id: string; category: string; name: string; ext: string; dir: string;
  rel_path: string; abs_path: string; readable: boolean; size: number;
  modified: string; stale?: boolean;
}
interface RemoteSlices { doc_id: string; collection?: string; count: number }

const listSchema = (raw: unknown): RemoteDocument[] => {
  const documents = (raw as { documents?: unknown }).documents;
  if (!Array.isArray(documents)) throw new Error('远端文档列表结构不符合预期');
  return documents as RemoteDocument[];
};

async function readSlices(docId: string): Promise<RemoteSlices | null> {
  const response = await fetch(`${baseUrl}/v1/documents/${encodeURIComponent(docId)}/slices`, { signal: AbortSignal.timeout(15000) });
  // 尚未生成切片返回 404；这类文档没有归属，跳过而不是写入孤儿行
  if (response.status === 404 || response.status === 403 || response.status === 401) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as RemoteSlices;
}

const database = new PostgresDatabase(config.databaseUrl, config.databaseSchema);
try {
  await database.migrate(config.databaseSchema);
  const health = await database.check();
  if (!health.connected) throw new Error(health.error ?? '数据库连接校验失败');
  const pool = database.rawPool;
  if (!pool) throw new Error('DATABASE_URL 未配置');

  const listed = await (await fetch(`${baseUrl}/v1/documents?category=${encodeURIComponent('上传文档')}`, { signal: AbortSignal.timeout(15000) })).json();
  const remote = listSchema(listed);
  console.log(`远端文档 ${remote.length} 个，开始确认集合归属（并发 ${concurrency}）…`);

  const resolved: { document: RemoteDocument; collection: string; chunkCount: number }[] = [];
  const skipped: string[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < remote.length) {
      const document = remote[cursor++]!;
      try {
        const slices = await readSlices(document.doc_id);
        if (!slices?.collection) { skipped.push(document.name); continue; }
        resolved.push({ document, collection: slices.collection, chunkCount: slices.count ?? 0 });
      } catch {
        skipped.push(document.name);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, remote.length) }, worker));

  const client = await pool.connect();
  let written = 0;
  try {
    // upsert：文档可能重新上传或改名，按 doc_id 更新并刷新 last_seen_at
    await client.query('BEGIN');
    for (const { document, collection, chunkCount } of resolved) {
      await client.query(
        `INSERT INTO knowledge_documents (doc_id, collection, name, ext, abs_path, size_bytes, chunk_count, modified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (doc_id) DO UPDATE SET collection = EXCLUDED.collection, name = EXCLUDED.name,
           ext = EXCLUDED.ext, abs_path = EXCLUDED.abs_path, size_bytes = EXCLUDED.size_bytes,
           chunk_count = EXCLUDED.chunk_count, modified_at = EXCLUDED.modified_at, last_seen_at = now()`,
        [document.doc_id, collection, document.name, document.ext ?? '', document.abs_path ?? '', document.size ?? 0, chunkCount, document.modified ? new Date(document.modified.replace(' ', 'T')) : null],
      );
      written++;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const total = await client.query<{ total: number; chunks: number }>('SELECT count(*)::int AS total, coalesce(sum(chunk_count),0)::int AS chunks FROM knowledge_documents');
  const byCollection = await client.query('SELECT collection, count(*)::int AS docs, sum(chunk_count)::int AS chunks FROM knowledge_documents GROUP BY collection ORDER BY docs DESC');
  console.log(`\n已写入 ${written} 条，跳过 ${skipped.length} 条（未切片或无归属）`);
  console.log('表内合计:', total.rows[0]?.total, '个文档,', total.rows[0]?.chunks, '个切片');
  for (const row of byCollection.rows) console.log(`  ${row.collection} -> ${row.docs} 个文档 / ${row.chunks} 个切片`);
  if (skipped.length) console.log('跳过:', skipped.join('、'));
  console.log('\n下一步：给身份授权（document_access_policy），否则代码接入 ACL 后会全部拒绝。');
} finally {
  await database.close();
}
