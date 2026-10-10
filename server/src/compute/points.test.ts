// 换算/精度/舍入与非法输入用例（P1-11 步骤 1 验收，DESIGN_POINTS_BASED_BILLING.md §10）。

import { describe, expect, it } from 'vitest';
import { DEFAULT_POINTS_PER_USD, createPointsConverter, normalizePointsPerUsd } from './points.js';

describe('points converter', () => {
  const converter = createPointsConverter();

  it('默认汇率 1 USD = 1000 点，rateAt 恒定返回当前汇率', () => {
    expect(DEFAULT_POINTS_PER_USD).toBe(1000);
    expect(converter.pointsPerUsd).toBe(1000);
    expect(converter.rateAt(new Date('2026-10-09T00:00:00Z'))).toBe(1000);
    expect(converter.rateAt(0)).toBe(1000);
  });

  it('fromUsd：毫积分精度并消除浮点噪声', () => {
    expect(converter.fromUsd(0)).toBe(0);
    expect(converter.fromUsd(0.01)).toBe(10);          // minReserve 口径
    expect(converter.fromUsd(0.0042)).toBe(4.2);       // 结算回流典型值
    expect(converter.fromUsd(0.005)).toBe(5);          // 博查 ¥0.036 ≈ $0.005 ≈ 5 点
    expect(converter.fromUsd(1)).toBe(1000);
    expect(converter.fromUsd(500)).toBe(500000);       // 存量迁移口径
  });

  it('fromUsd：低于毫积分精度的金额舍入到 0（不产生碎点）', () => {
    expect(converter.fromUsd(0.0000001)).toBe(0);      // 0.0001 点 < 0.0005，舍入为 0
    expect(converter.fromUsd(0.0000005)).toBe(0.001);  // 恰好进位到 1 毫点
  });

  it('toUsd：8 位小数精度，用于 Sub2API 余额同步', () => {
    expect(converter.toUsd(0)).toBe(0);
    expect(converter.toUsd(4.2)).toBe(0.0042);
    expect(converter.toUsd(500000)).toBe(500);
    expect(converter.toUsd(1)).toBe(0.001);
    expect(converter.toUsd(0.001)).toBe(0.000001);     // 1 毫点
  });

  it('往返不变式：toUsd(fromUsd(x)) 在 USD 精度内还原', () => {
    for (const usd of [0.0042, 0.01, 0.036, 1.25, 12.345678]) {
      expect(converter.toUsd(converter.fromUsd(usd))).toBeCloseTo(usd, 8);
    }
  });

  it('非法输入一律抛错：非正汇率、负数/非有限金额', () => {
    expect(() => normalizePointsPerUsd(0)).toThrow(/POINTS_PER_USD/);
    expect(() => normalizePointsPerUsd(-1000)).toThrow(/POINTS_PER_USD/);
    expect(() => normalizePointsPerUsd(Number.NaN)).toThrow(/POINTS_PER_USD/);
    expect(() => normalizePointsPerUsd(Number.POSITIVE_INFINITY)).toThrow(/POINTS_PER_USD/);
    expect(() => createPointsConverter(999.6)).toThrow(/迁移台账/);

    expect(() => converter.fromUsd(-0.01)).toThrow(/USD 成本/);
    expect(() => converter.fromUsd(Number.NaN)).toThrow(/USD 成本/);
    expect(() => converter.toUsd(Number.POSITIVE_INFINITY)).toThrow(/POINTS_PER_USD/);
  });

  it('toUsd 支持带符号增量（Sub2API 转账 -X/+X 场景）', () => {
    expect(converter.toUsd(-30000)).toBe(-30);
    expect(converter.toUsd(12000)).toBe(12);
    expect(converter.toUsd(0)).toBe(0);
  });

  it('非 1000 的汇率必须先完成台账迁移', () => {
    expect(normalizePointsPerUsd(1000)).toBe(1000);
    expect(() => createPointsConverter(500)).toThrow(/迁移台账/);
  });
});
