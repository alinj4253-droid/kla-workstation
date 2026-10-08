// 对账服务：比较 KLA 侧 quota_used 与 Sub2API 侧用量累计，检测漂移。

import type { Pool } from 'pg';
import type { ComputeRepository } from './compute-repository.js';
import type { Sub2ApiClient } from './sub2api-client.js';
import { roundUsd } from './types.js';

export class ReconciliationService {
  constructor(
    private readonly pool: Pool,
    private readonly repo: ComputeRepository,
    private readonly sub2api: Sub2ApiClient,
  ) {}

  /** 对单个身份执行对账 */
  async reconcileIdentity(identityId: string, thresholdUsd = 0.01): Promise<{ driftUsd: number; status: 'ok' | 'warning' | 'error' }> {
    const binding = await this.repo.getBinding(identityId);
    if (!binding || !binding.sub2apiUserId) {
      return { driftUsd: 0, status: 'ok' };
    }

    // KLA 侧：SUM(compute_usage.amount_usd) WHERE identity_id
    const klaUsed = await this.repo.sumUsageByIdentity(identityId);

    // Sub2API 侧：拉取全量用量求和
    let sub2apiUsed = 0;
    try {
      const items = await this.sub2api.listUsage(binding.sub2apiUserId);
      sub2apiUsed = items.reduce((sum, i) => sum + i.amountUsd, 0);
    } catch (error) {
      await this.repo.insertSyncLog({
        syncType: 'reconciliation',
        identityId,
        klaAmount: klaUsed,
        status: 'error',
        message: error instanceof Error ? error.message : 'Sub2API 用量查询失败',
      });
      return { driftUsd: 0, status: 'error' };
    }

    const driftUsd = roundUsd(klaUsed - sub2apiUsed);
    const status: 'ok' | 'warning' = Math.abs(driftUsd) > thresholdUsd ? 'warning' : 'ok';
    await this.repo.insertSyncLog({
      syncType: 'reconciliation',
      identityId,
      klaAmount: klaUsed,
      sub2apiAmount: sub2apiUsed,
      driftUsd,
      status,
      message: status === 'warning' ? `用量漂移 ${driftUsd} USD，超过阈值 ${thresholdUsd}` : null,
    });
    return { driftUsd, status };
  }

  /** 批量对账所有已绑定身份 */
  async reconcileAll(thresholdUsd = 0.01): Promise<Array<{ identityId: string; driftUsd: number; status: string }>> {
    const { rows } = await this.pool.query(
      "SELECT identity_id FROM compute_bindings WHERE sub2api_user_id IS NOT NULL",
    );
    const results: Array<{ identityId: string; driftUsd: number; status: string }> = [];
    for (const row of rows) {
      const r = await this.reconcileIdentity(row.identity_id as string, thresholdUsd);
      results.push({ identityId: row.identity_id as string, driftUsd: r.driftUsd, status: r.status });
    }
    return results;
  }
}
