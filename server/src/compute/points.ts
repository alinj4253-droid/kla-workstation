// 算力点 ↔ USD 单一换算口径（docs/DESIGN_POINTS_BASED_BILLING.md §3）。
//
// 规则：
// - 换算只允许发生在两个边界：usd→points（结算回流/用量落库）与 points→usd（同步 Sub2API 余额），
//   中间环节各用原生精度，严禁往返换算。
// - 积分精度 NUMERIC(20,3)（毫积分）；USD 精度 NUMERIC(20,8)（与 Sub2API 一致）。
// - 当前汇率锁定为 1000（1 元 = 1 美元 = 1000 积分）；rateAt() 预留按生效时间查表，
//   二期落 compute_rate_config 后，历史流水靠 rate_snapshot 自解释。
//
// 汇率调整视同重大变更：发版 + 存量重估迁移（§9），不是运行时可改参数。

export const DEFAULT_POINTS_PER_USD = 1000;

/** 当前运行时只允许 1000；调整汇率需先迁移台账（存量 points_* / amount_points 重算）。 */
export function normalizePointsPerUsd(pointsPerUsd: number): number {
  if (pointsPerUsd !== DEFAULT_POINTS_PER_USD) {
    throw new Error(`POINTS_PER_USD 当前必须为 ${DEFAULT_POINTS_PER_USD}，变更汇率需先迁移台账`);
  }
  return DEFAULT_POINTS_PER_USD;
}

export type PointsConverter = {
  /** 每美元对应的算力点数 */
  readonly pointsPerUsd: number;
  /** 请求开始时点的汇率快照；MVP 恒定，二期按生效时间查配置表 */
  rateAt: (at: Date | string | number) => number;
  /** USD 成本 → 算力点（毫积分精度，四舍五入到 0.001 点） */
  fromUsd: (usd: number) => number;
  /** 算力点 → USD（NUMERIC(20,8) 精度），支持带符号增量（Sub2API 余额同步/转账） */
  toUsd: (points: number) => number;
};

function assertNonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label}必须是非负有限数，收到 ${value}`);
  }
  return value;
}

export function createPointsConverter(pointsPerUsd: number = DEFAULT_POINTS_PER_USD): PointsConverter {
  const rate = normalizePointsPerUsd(pointsPerUsd);
  return {
    pointsPerUsd: rate,
    rateAt: () => rate,
    fromUsd: (usd) => usdToPoints(assertNonNegativeFinite(usd, 'USD 成本'), rate),
    toUsd: (points) => pointsToUsd(points, rate),
  };
}

/** USD 成本 → 算力点（毫积分精度，非负）。独立纯函数，供不便持有 converter 的调用方使用。 */
export function usdToPoints(usd: number, pointsPerUsd: number): number {
  if (!Number.isFinite(pointsPerUsd) || pointsPerUsd <= 0) throw new Error(`POINTS_PER_USD 必须是正有限数，收到 ${pointsPerUsd}`);
  // 先放大到毫积分再取整，消除浮点噪声（如 0.0042*1000=4.200000000000001）
  return Math.round(assertNonNegativeFinite(usd, 'USD 成本') * pointsPerUsd * 1000) / 1000;
}

/** 算力点 → USD（NUMERIC(20,8) 精度）。支持带符号增量（如 Sub2API 转账 -X/+X）。 */
export function pointsToUsd(points: number, pointsPerUsd: number): number {
  if (!Number.isFinite(points) || !Number.isFinite(pointsPerUsd) || pointsPerUsd <= 0) {
    throw new Error(`POINTS_PER_USD 必须是正有限数，收到 ${pointsPerUsd}`);
  }
  return Math.round(points / pointsPerUsd * 1e8) / 1e8;
}
