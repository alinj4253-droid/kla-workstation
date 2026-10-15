// 存量用量回填：按 compute_bindings 的上游账号逐个拉取 Sub2API 计费明细，
// 将 cache_creation_tokens / cache_read_tokens / duration_ms 回填到 compute_usage
// （仅匹配 sub2api_usage_id 且 latency_ms 为空的行，不覆盖本地失败记录的耗时）。
// 幂等可重跑；对上游每账号间隔 150ms，避免触发限流。
// 用法：node scripts/backfill-usage-cache-latency.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
}
const base = process.env.SUB2API_BASE_URL?.replace(/\/$/, '');
const adminKey = process.env.SUB2API_ADMIN_API_KEY;
if (!base || !adminKey) { console.error('缺少 SUB2API_BASE_URL / SUB2API_ADMIN_API_KEY'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchUsage(userId) {
  const items = [];
  for (let page = 1; page <= 100; page++) {
    const resp = await fetch(`${base}/api/v1/admin/usage?user_id=${userId}&page=${page}&page_size=100`, { headers: { 'x-api-key': adminKey } });
    if (!resp.ok) throw new Error(`上游 ${resp.status}: ${await resp.text()}`);
    const body = await resp.json();
    const rows = body?.data?.items ?? [];
    items.push(...rows);
    if (rows.length === 0 || page >= Number(body?.data?.pages ?? page)) break;
    await sleep(100);
  }
  return items;
}

const client = new Client({ connectionString: process.env.DATABASE_URL, options: '-c search_path=kla,public' });
await client.connect();
const bindings = await client.query('SELECT DISTINCT sub2api_user_id FROM compute_bindings WHERE sub2api_user_id IS NOT NULL');
let updated = 0;
for (const { sub2api_user_id: userId } of bindings.rows) {
  let items;
  try {
    items = await fetchUsage(userId);
  } catch (err) {
    console.warn(`user ${userId} 拉取失败，跳过：${err.message}`);
    continue;
  }
  for (const row of items) {
    if (row.id == null) continue;
    const r = await client.query(
      `UPDATE compute_usage
         SET cache_creation_tokens = COALESCE($2, 0),
             cache_read_tokens = COALESCE($3, 0),
             latency_ms = COALESCE(latency_ms, $4)
       WHERE sub2api_usage_id = $1 AND latency_ms IS NULL`,
      [String(row.id), Number(row.cache_creation_tokens ?? 0), Number(row.cache_read_tokens ?? 0), row.duration_ms == null ? null : Number(row.duration_ms)],
    );
    updated += r.rowCount;
  }
  await sleep(150);
}
const after = await client.query(
  'SELECT count(*)::int AS n, count(latency_ms)::int AS with_latency, sum(cache_read_tokens + cache_creation_tokens)::bigint AS cache_total FROM compute_usage',
);
console.log(`回填更新行数：${updated}`);
console.log(`回填后用量行：${JSON.stringify(after.rows[0])}`);
await client.end();
