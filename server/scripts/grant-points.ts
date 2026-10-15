// 平台运维发放算力点。
//
// 用法：
//   pnpm points:grant -- --identity-id <uuid> --points 100000 --request-id <唯一编号>
//   pnpm points:grant -- --email user@example.com --target-balance 100000 --request-id <唯一编号>
//
// 所有写入均通过 QuotaService.grant，避免绕过台账、幂等和 Sub2API 同步。

import { loadConfig } from '../src/config.js';
import { PostgresDatabase } from '../src/database/postgres.js';
import { RedisDatabase } from '../src/infrastructure/redis.js';
import { ComputeRepository } from '../src/compute/compute-repository.js';
import { QuotaService } from '../src/compute/quota-service.js';
import { Sub2ApiClient } from '../src/compute/sub2api-client.js';
import { createPointsConverter } from '../src/compute/points.js';
import { availableBalance } from '../src/compute/types.js';

type IdentityRow = {
  id: string;
  email: string;
  display_name: string;
  type: string;
  organization_id: string | null;
};

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要一个值`);
  return value;
}

function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`缺少参数 ${name}`);
  return value;
}

function positiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} 必须是大于 0 的数字`);
  return parsed;
}

const config = loadConfig();
const identityId = option('--identity-id');
const email = option('--email')?.toLowerCase();
const pointsArg = option('--points');
const targetBalanceArg = option('--target-balance');
const requestId = required('--request-id');

if (!config.databaseUrl) throw new Error('DATABASE_URL 未配置');
if (!identityId && !email) throw new Error('必须提供 --identity-id 或 --email');
if (identityId && email) throw new Error('--identity-id 与 --email 只能二选一');
if (pointsArg && targetBalanceArg) throw new Error('--points 与 --target-balance 只能二选一');
if (!pointsArg && !targetBalanceArg) throw new Error('必须提供 --points 或 --target-balance');

const database = new PostgresDatabase(config.databaseUrl, config.databaseSchema);
const redis = new RedisDatabase(config.redisUrl);
const pool = database.rawPool;
if (!pool) throw new Error('数据库连接不可用');

try {
  await database.migrate(config.databaseSchema);

  let identity: IdentityRow;
  if (identityId) {
    const result = await pool.query<IdentityRow>(
      `SELECT i.id, u.email, i.display_name, i.type, i.organization_id
       FROM identities i JOIN users u ON u.id = i.user_id
       WHERE i.id = $1 AND i.status = 'active'`,
      [identityId],
    );
    if (result.rows.length !== 1) throw new Error(`未找到 active 身份：${identityId}`);
    identity = result.rows[0];
  } else {
    const result = await pool.query<IdentityRow>(
      `SELECT i.id, u.email, i.display_name, i.type, i.organization_id
       FROM identities i JOIN users u ON u.id = i.user_id
       WHERE lower(u.email) = $1 AND i.status = 'active'
       ORDER BY i.created_at`,
      [email],
    );
    if (result.rows.length === 0) throw new Error(`未找到 active 身份：${email}`);
    if (result.rows.length > 1) {
      const choices = result.rows.map(row => `${row.id}（${row.display_name}/${row.type}）`).join('、');
      throw new Error(`邮箱匹配到多个身份，请改用 --identity-id：${choices}`);
    }
    identity = result.rows[0];
  }

  const points = createPointsConverter(config.compute.pointsPerUsd);
  const repo = new ComputeRepository(pool, points);
  const sub2api = new Sub2ApiClient(config.sub2api, redis);
  const quota = new QuotaService(pool, repo, sub2api, points);
  const owner = { identityId: identity.id };
  const currentEntitlement = await repo.getEntitlement(owner);
  const currentAvailable = currentEntitlement ? availableBalance(currentEntitlement) : 0;

  let grantAmount: number;
  if (pointsArg) {
    grantAmount = positiveNumber(pointsArg, '--points');
  } else {
    const target = positiveNumber(targetBalanceArg!, '--target-balance');
    grantAmount = Math.round((target - currentAvailable) * 1000) / 1000;
    if (grantAmount < 0) {
      throw new Error(`当前可用余额 ${currentAvailable} 点已高于目标 ${target} 点，不执行负向发放`);
    }
    if (grantAmount === 0) {
      console.log(`无需发放：${identity.display_name} 当前可用余额已是 ${currentAvailable} 点`);
    }
  }

  if (grantAmount === 0) process.exitCode = 0;
  else {
    const result = await quota.grant(owner, grantAmount, requestId);
    const entitlement = await repo.getEntitlement(owner);
    const ledger = await repo.getLedger(result.ledgerId);
    if (!entitlement || !ledger) throw new Error('发放成功但读取结果失败');

    console.log(JSON.stringify({
      identity: {
        id: identity.id,
        email: identity.email,
        displayName: identity.display_name,
        type: identity.type,
        organizationId: identity.organization_id,
      },
      grantPoints: grantAmount,
      currentAvailableBefore: currentAvailable,
      entitlement: {
        pointsTotal: entitlement.quotaTotal,
        pointsGranted: entitlement.quotaGranted,
        pointsUsed: entitlement.quotaUsed,
        pointsReserved: entitlement.quotaReserved,
        availablePoints: availableBalance(entitlement),
      },
      ledger: {
        id: ledger.id,
        operation: ledger.operation,
        amountPoints: ledger.amount,
        idempotencyKey: ledger.idempotencyKey,
        sub2apiSynced: ledger.sub2apiSynced,
      },
    }, null, 2));
  }
} finally {
  await database.close();
  await redis.close();
}
