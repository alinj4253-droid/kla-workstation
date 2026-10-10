// 算力点汇率重估：回到 1000（1 元 = 1 美元 = 1000 积分）。
//
// 以 USD 影子列（quota_* / amount / amount_usd）为唯一真值，重算所有积分列：
// 1. compute_entitlements：points_* = quota_* × 1000；
// 2. compute_allocation_ledger：amount_points = amount × 1000，rate_snapshot = 1000；
// 3. compute_usage：amount_points = amount_usd × 1000。
//
// 幂等性：重算结果与汇率成正比，重复执行收敛到同一值；rate_snapshot 直接覆盖。
// 用法：node --import tsx scripts/revalue-points.ts [--dry-run]

import { loadConfig } from '../src/config.js';
import { PostgresDatabase } from '../src/database/postgres.js';
import { createPointsConverter } from '../src/compute/points.js';

const config = loadConfig();
const rate = config.compute.pointsPerUsd;
const converter = createPointsConverter(rate);
const dryRun = process.argv.includes('--dry-run');

if (rate !== 1000) {
  console.error(`当前 POINTS_PER_USD=${rate}，本脚本仅用于重估到 1000，请先确认配置`);
  process.exit(2);
}
if (!config.databaseUrl) {
  console.error('DATABASE_URL 未配置');
  process.exit(2);
}

const db = new PostgresDatabase(config.databaseUrl, config.databaseSchema);
const pool = db.rawPool;
if (!pool) {
  console.error('数据库连接不可用');
  process.exit(2);
}

try {
  if (dryRun) console.log('[dry-run] 仅统计，不写入');

  // 触发器在 compute_billing_cutover 存在且 kla.upstream_usage != 'on' 时会冻结 used 列，
  // 重估需放行。开启事务并设置会话变量。
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL kla.upstream_usage = 'on'");

    const ent = await client.query(
      `UPDATE compute_entitlements
       SET points_total = ROUND(quota_total * $1::numeric, 3),
           points_granted = ROUND(quota_granted * $1::numeric, 3),
           points_used = ROUND(quota_used * $1::numeric, 3),
           points_reserved = ROUND(quota_reserved * $1::numeric, 3),
           updated_at = now()`,
      [rate],
    );
    console.log(`entitlements 重估 ${ent.rowCount ?? 0} 行（points_* = quota_* × ${rate}）`);

    const ledger = await client.query(
      `UPDATE compute_allocation_ledger
       SET amount_points = ROUND(amount * $1::numeric, 3), rate_snapshot = $1::numeric
       WHERE amount <> 0`,
      [rate],
    );
    console.log(`ledger 重估 ${ledger.rowCount ?? 0} 行（amount_points = amount × ${rate}，rate_snapshot=${rate}）`);

    const usage = await client.query(
      `UPDATE compute_usage
       SET amount_points = ROUND(amount_usd * $1::numeric, 3)
       WHERE amount_usd > 0`,
      [rate],
    );
    console.log(`usage 重估 ${usage.rowCount ?? 0} 行（amount_points = amount_usd × ${rate}）`);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // 校验抽样
  const sample = await pool.query(
    `SELECT identity_id, quota_total, points_total, quota_used, points_used
     FROM compute_entitlements WHERE quota_total <> 0 LIMIT 3`,
  );
  for (const row of sample.rows) {
    const expected = converter.fromUsd(Number(row.quota_total));
    console.log(
      `  ${row.identity_id}: quota_total=${row.quota_total} USD → points_total=${row.points_total}（期望 ${expected}）`,
    );
  }

  console.log(`\n重估完成：汇率 1 USD = ${rate} 积分（1 元 = 1 美元 = ${rate} 积分）${dryRun ? '（dry-run，未写入）' : ''}`);
} finally {
  await db.close();
}
