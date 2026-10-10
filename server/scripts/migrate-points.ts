// 存量算力点迁移（P1-11 步骤 5 / docs/DESIGN_POINTS_BASED_BILLING.md §9）
//
// 把 0013 时期的 USD 影子口径一次性换算为算力点主口径：
// 1. compute_entitlements：points_* 四件套 = quota_* 四件套 × 汇率，并落一条幂等迁移流水（operation=recharge, source=points_migration）；
// 2. compute_usage / compute_allocation_ledger：回填存量行 amount_points（单条 SQL，WHERE amount_points=0 天然幂等）。
//
// 幂等性：每个 entitlement 以 `migrate-points:{id}` 幂等键判定，重复执行自动跳过；
//         usage/ledger 回填按 amount_points=0 条件收敛。
// 用法：pnpm -C server points:migrate [--dry-run]
// 注意：先执行 db:migrate（0021 及以后）再运行本脚本；汇率调整后不得重跑（迁移流水已存在会跳过，
//       汇率变更请走设计文档 §9 的重估流程）。

import { loadConfig } from '../src/config.js';
import { PostgresDatabase } from '../src/database/postgres.js';
import { usdToPoints } from '../src/compute/points.js';

const config = loadConfig();
const rate = config.compute.pointsPerUsd;
const dryRun = process.argv.includes('--dry-run');

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

type EntitlementRow = {
  id: string;
  identity_id: string | null;
  organization_id: string | null;
  quota_total: string;
  quota_granted: string;
  quota_used: string;
  quota_reserved: string;
};

const num = (v: string | null): number => Number(v ?? 0);

let migrated = 0;
let skippedDone = 0;
let skippedZero = 0;

try {
  if (dryRun) console.log('[dry-run] 仅统计，不写入');

  const { rows } = await pool.query<EntitlementRow>(
    'SELECT id, identity_id, organization_id, quota_total, quota_granted, quota_used, quota_reserved FROM compute_entitlements ORDER BY created_at',
  );

  for (const row of rows) {
    const usd = {
      total: num(row.quota_total),
      granted: num(row.quota_granted),
      used: num(row.quota_used),
      reserved: num(row.quota_reserved),
    };
    const points = {
      total: usdToPoints(usd.total, rate),
      granted: usdToPoints(usd.granted, rate),
      used: usdToPoints(usd.used, rate),
      reserved: usdToPoints(usd.reserved, rate),
    };
    const idempotencyKey = `migrate-points:${row.id}`;
    const hasZeroUsd = usd.total === 0 && usd.granted === 0 && usd.used === 0 && usd.reserved === 0;

    const { rows: existing } = await pool.query('SELECT 1 FROM compute_allocation_ledger WHERE idempotency_key = $1', [idempotencyKey]);
    if (existing.length > 0) {
      skippedDone += 1;
      continue;
    }
    if (hasZeroUsd) {
      skippedZero += 1;
      continue;
    }

    if (dryRun) {
      migrated += 1;
      console.log(`[dry-run] ${row.id}（${row.identity_id ?? row.organization_id}）: ${usd.total} USD → ${points.total} 点`);
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // 行锁 + 幂等复核（并发保护）
      await client.query('SELECT id FROM compute_entitlements WHERE id = $1 FOR UPDATE', [row.id]);
      const { rows: recheck } = await client.query('SELECT 1 FROM compute_allocation_ledger WHERE idempotency_key = $1', [idempotencyKey]);
      if (recheck.length > 0) {
        await client.query('ROLLBACK');
        skippedDone += 1;
        continue;
      }
      await client.query(
        `UPDATE compute_entitlements
         SET points_total = $2, points_granted = $3, points_used = $4, points_reserved = $5, updated_at = now()
         WHERE id = $1`,
        [row.id, points.total, points.granted, points.used, points.reserved],
      );
      // 影子口径 amount 直读存量 quota_total（历史真实 USD），权威口径为 points_total
      await client.query(
        `INSERT INTO compute_allocation_ledger
           (entitlement_id, operation, amount, amount_points, rate_snapshot, status, idempotency_key, request_id, metadata)
         VALUES ($1, 'recharge', $2, $3, $4, 'completed', $5, $6, $7)`,
        [
          row.id,
          usd.total,
          points.total,
          rate,
          idempotencyKey,
          `migrate-${row.id}`,
          { source: 'points_migration', rate, usdSnapshot: usd, pointsSnapshot: points, identityId: row.identity_id, organizationId: row.organization_id },
        ],
      );
      await client.query('COMMIT');
      migrated += 1;
      console.log(`✓ ${row.id}（${row.identity_id ?? row.organization_id}）: ${usd.total} USD → ${points.total} 点`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // 存量 usage / ledger 行回填（单条 SQL，WHERE amount_points=0 幂等）
  if (!dryRun) {
    const usageBackfill = await pool.query(
      'UPDATE compute_usage SET amount_points = ROUND(amount_usd * $1::numeric, 3) WHERE amount_points = 0 AND amount_usd > 0',
      [rate],
    );
    const ledgerBackfill = await pool.query(
      `UPDATE compute_allocation_ledger
       SET amount_points = ROUND(amount * $1::numeric, 3), rate_snapshot = $1::numeric
       WHERE amount_points = 0 AND amount <> 0`,
      [rate],
    );
    console.log(`usage 回填 ${usageBackfill.rowCount ?? 0} 行；ledger 回填 ${ledgerBackfill.rowCount ?? 0} 行`);
  } else {
    const usageCount = await pool.query<{ total: string }>('SELECT count(*)::text AS total FROM compute_usage WHERE amount_points = 0 AND amount_usd > 0');
    const ledgerCount = await pool.query<{ total: string }>('SELECT count(*)::text AS total FROM compute_allocation_ledger WHERE amount_points = 0 AND amount <> 0');
    console.log(`[dry-run] 待回填 usage ${usageCount.rows[0]?.total ?? 0} 行、ledger ${ledgerCount.rows[0]?.total ?? 0} 行`);
  }

  console.log(`\n完成：迁移 ${migrated} 个额度池；已迁移跳过 ${skippedDone}；无存量跳过 ${skippedZero}；汇率 1 USD = ${rate} 点${dryRun ? '（dry-run，未写入）' : ''}`);
} finally {
  await db.close();
}
