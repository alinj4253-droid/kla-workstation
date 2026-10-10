// 算力点余额对账（P1-11 验收 / docs/DESIGN_POINTS_BASED_BILLING.md §9）
//
// 口径：Σ points ÷ rate ≈ Sub2API 余额。
// 对每个已就绪绑定：KLA 可用点数（total+granted-used-reserved）按当前汇率换算为期望 USD，
// 与上游实测余额比对；|漂移| > 容差时写 compute_sync_logs（reconciliation/warning）并以退出码 1 结束。
//
// 用法：pnpm -C server points:reconcile [--tol=0.01]
// 退出码：0 无漂移；1 存在漂移；2 配置/连接错误。

import { loadConfig } from '../src/config.js';
import { PostgresDatabase } from '../src/database/postgres.js';
import { RedisDatabase } from '../src/infrastructure/redis.js';
import { Sub2ApiClient } from '../src/compute/sub2api-client.js';
import { createPointsConverter } from '../src/compute/points.js';
import { roundUsd } from '../src/compute/types.js';

const config = loadConfig();
const converter = createPointsConverter(config.compute.pointsPerUsd);
if (!config.databaseUrl) {
  console.error('DATABASE_URL 未配置');
  process.exit(2);
}
if (!config.sub2api.adminApiKey || !config.sub2api.baseUrl) {
  console.error('SUB2API_BASE_URL / SUB2API_ADMIN_API_KEY 未配置，无法拉取上游余额');
  process.exit(2);
}

const tolArg = process.argv.find((arg) => arg.startsWith('--tol='));
const tolerance = tolArg ? Number(tolArg.split('=')[1]) : 0.01;
if (!Number.isFinite(tolerance) || tolerance < 0) {
  console.error('--tol 必须是非负数字（USD）');
  process.exit(2);
}

const db = new PostgresDatabase(config.databaseUrl, config.databaseSchema);
const redis = new RedisDatabase(config.redisUrl);
const pool = db.rawPool;
if (!pool) {
  console.error('数据库连接不可用');
  await db.close();
  await redis.close();
  process.exit(2);
}

type BindingRow = {
  identity_id: string;
  sub2api_user_id: string;
  points_total: string;
  points_granted: string;
  points_used: string;
  points_reserved: string;
};

let checked = 0;
let drifted = 0;
const lines: string[] = [];

try {
  const sub2api = new Sub2ApiClient(config.sub2api, redis);
  const { rows } = await pool.query<BindingRow>(
    `SELECT b.identity_id, b.sub2api_user_id,
            COALESCE(e.points_total, 0) AS points_total, COALESCE(e.points_granted, 0) AS points_granted,
            COALESCE(e.points_used, 0) AS points_used, COALESCE(e.points_reserved, 0) AS points_reserved
     FROM compute_bindings b
     LEFT JOIN compute_entitlements e ON e.identity_id = b.identity_id
     WHERE b.sub2api_status IN ('ready', 'user_created', 'default_key_created', 'balance_granted')
     ORDER BY b.identity_id`,
  );

  for (const row of rows) {
    const klaPoints =
      Number(row.points_total) + Number(row.points_granted) - Number(row.points_used) - Number(row.points_reserved);
    const expectedUsd = converter.toUsd(Math.max(klaPoints, 0));
    let actualUsd: number | null = null;
    let error: string | null = null;
    try {
      const user = await sub2api.getUser(row.sub2api_user_id);
      actualUsd = user?.balance ?? 0;
    } catch (err) {
      error = err instanceof Error ? err.message : 'unknown';
    }

    checked += 1;
    if (error !== null || actualUsd === null) {
      drifted += 1;
      lines.push(`✗ ${row.identity_id} 上游查询失败：${error}`);
      await pool.query(
        `INSERT INTO compute_sync_logs (sync_type, identity_id, kla_amount, status, message)
         VALUES ('reconciliation', $1, $2, 'error', $3)`,
        [row.identity_id, klaPoints, `对账失败：${error}`],
      );
      continue;
    }

    const drift = roundUsd(actualUsd - expectedUsd);
    if (Math.abs(drift) > tolerance) {
      drifted += 1;
      lines.push(`✗ ${row.identity_id} 漂移 ${drift} USD（KLA ${klaPoints} 点 ≈ ${expectedUsd} USD，上游 ${actualUsd} USD）`);
      await pool.query(
        `INSERT INTO compute_sync_logs (sync_type, identity_id, kla_amount, sub2api_amount, drift_usd, status, message)
         VALUES ('reconciliation', $1, $2, $3, $4, 'warning', $5)`,
        [
          row.identity_id,
          klaPoints,
          actualUsd,
          drift,
          `算力点对账漂移：KLA ${klaPoints} 点 ≈ ${expectedUsd} USD，上游实测 ${actualUsd} USD`,
        ],
      );
    } else {
      lines.push(`✓ ${row.identity_id} ${klaPoints} 点 ≈ ${expectedUsd} USD（上游 ${actualUsd} USD）`);
    }
  }

  for (const line of lines) console.log(line);
  console.log(`\n对账完成：检查 ${checked} 个绑定，漂移 ${drifted} 个（容差 ${tolerance} USD，汇率 1 USD = ${config.compute.pointsPerUsd} 点）`);
  process.exitCode = drifted > 0 ? 1 : 0;
} finally {
  await db.close();
  await redis.close();
}
