/**
 * 把 KLA 的 knowledge_documents 表里的归属回填到远端知识服务（8120）。
 *
 * 背景：远端归属过滤依赖 {WORKSPACE}/.scopes/scopes.json，只有上传时登记的文档才有记录；
 * 存量文档是历史上直接落在工作区里的，没有归属。这里按 KLA 库里已有的
 * knowledge_documents.knowledge_base_id 批量补登记（doc_id → knowledge_base_id）。
 *
 * 只读 KLA 数据库、只调远端的 POST /v1/scope/bulk，不改任何业务数据。
 *
 * 用法：
 *   node scripts/backfill-scope.mjs                 # 预览（只打印要回填多少条，不发请求）
 *   node scripts/backfill-scope.mjs --apply         # 真执行（分批，每批 100 条）
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const env = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
const pick = key => (env.split(/\r?\n/).find(line => line.trim().startsWith(key + '=')) ?? key + '=').split('=')[1].trim().replace(/^["']|["']$/g, '');
const apply = process.argv.includes('--apply');
const baseUrl = (process.env.KNOWLEDGE_BASE_URL || 'http://192.168.10.206:8120').replace(/\/$/, '');
const apiKey = process.env.KB_API_KEY || '';
const BATCH = 100;

const client = new pg.Client({ connectionString: pick('DATABASE_URL'), connectionTimeoutMillis: 8000 });
await client.connect();
await client.query(`SET search_path TO "${pick('DATABASE_SCHEMA') || 'kla'}", public`);

// 只回填已关联到知识库的文档；未归属（NULL）的不动，避免越权扩散
const result = await client.query(`SELECT d.doc_id, d.name, d.knowledge_base_id, b.collection
  FROM knowledge_documents d JOIN knowledge_bases b ON b.id = d.knowledge_base_id
  WHERE d.knowledge_base_id IS NOT NULL ORDER BY d.doc_id`);
await client.end();

console.log(`待回填 ${result.rowCount} 篇文档 →知识库`);
const byBase = new Map();
for (const row of result.rows) {
  if (!byBase.has(row.knowledge_base_id)) byBase.set(row.knowledge_base_id, { collection: row.collection, docs: [] });
  byBase.get(row.knowledge_base_id).docs.push(row.doc_id);
}
for (const [baseId, info] of byBase) console.log(`  ${info.collection} (${baseId}): ${info.docs.length} 篇`);

if (!apply) {
  console.log('\n这是预览。加 --apply 真正回填。');
  process.exit(0);
}

const header = apiKey ? { 'content-type': 'application/json', 'x-api-key': apiKey } : { 'content-type': 'application/json' };
for (const [baseId, info] of byBase) {
  let done = 0;
  for (let start = 0; start < info.docs.length; start += BATCH) {
    const items = info.docs.slice(start, start + BATCH).map(doc_id => ({ doc_id, knowledge_base_id: baseId }));
    const response = await fetch(`${baseUrl}/v1/scope/bulk`, { method: 'POST', headers: header, body: JSON.stringify({ items }) });
    if (!response.ok) throw new Error(`回填失败：HTTP ${response.status} ${await response.text()}`);
    const body = await response.json();
    done += body.updated ?? items.length;
    process.stdout.write(`\r  ${info.collection}: ${done}/${info.docs.length}`);
  }
  console.log(`\n  ${info.collection} 回填完成`);
}
console.log('\n完成。现在远端按 knowledge_base_id 过滤已生效（需要 8120 已重启加载新代码）。');