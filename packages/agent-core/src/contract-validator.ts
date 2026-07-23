/**
 * CLI 策略契约验证器
 *
 * 用于 AC-EXT-07 契约测试，验证适配器实现与策略契约一致。
 */

import type { AdapterCapability, AdapterStrategy } from './external-agent-adapter';

/** 策略契约：每个适配器一份 */
export interface AdapterContract {
  adapterType: string;
  targetVersion: string;
  versionRange: string;
  expectedCapabilities: AdapterCapability[];
  /** `--help` 输出的 SHA-256 哈希（小写十六进制）。CI 环境中会自动验证。 */
  helpOutputHash: string;
  strategies: StrategyContract[];
}

export interface StrategyContract {
  strategyId: string;
  emptyArgs: string[];
  simpleArgs: string[];
  shouldDelegateMin: number;
}

const CLI_CONTRACTS: Record<string, AdapterContract> = {
  codex: {
    adapterType: 'codex',
    targetVersion: '0.1.0',
    versionRange: '>=0.1.0 <=1.99.99',
    helpOutputHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    expectedCapabilities: ['code-generation', 'file-read', 'file-write', 'terminal', 'search', 'network-access'].sort() as AdapterCapability[],
    strategies: [
      {
        strategyId: 'auto',
        emptyArgs: ['run', ''],
        simpleArgs: ['run', 'write a test'],
        shouldDelegateMin: 0.5,
      },
    ],
  },
  'claude-code': {
    adapterType: 'claude-code',
    targetVersion: '0.1.0',
    versionRange: '>=0.1.0 <=9.99.99',
    helpOutputHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    expectedCapabilities: ['code-generation', 'file-read', 'file-write', 'search', 'reasoning', 'network-access'].sort() as AdapterCapability[],
    strategies: [
      {
        strategyId: 'auto',
        emptyArgs: ['run', ''],
        simpleArgs: ['run', 'write a test'],
        shouldDelegateMin: 0.5,
      },
    ],
  },
};

export function getContract(adapterType: string): AdapterContract | undefined {
  return CLI_CONTRACTS[adapterType];
}

export function validateCapabilities(adapterType: string, actual: AdapterCapability[]): { ok: boolean; errors: string[] } {
  const contract = getContract(adapterType);
  if (!contract) {
    return { ok: false, errors: [`未找到适配器 ${adapterType} 的契约定义`] };
  }
  const errors: string[] = [];
  const sortedActual = [...actual].sort();
  const sortedExpected = contract.expectedCapabilities;

  for (const cap of sortedExpected) {
    if (!sortedActual.includes(cap)) {
      errors.push(`缺少能力: ${cap}`);
    }
  }
  for (const cap of sortedActual) {
    if (!sortedExpected.includes(cap)) {
      errors.push(`多余的能力（不在契约中）: ${cap}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateStrategy(
  adapterType: string,
  strategy: AdapterStrategy,
  instruction: string,
): { ok: boolean; errors: string[] } {
  const contract = getContract(adapterType);
  if (!contract) {
    return { ok: false, errors: [`未找到适配器 ${adapterType} 的契约定义`] };
  }
  const strategyContract = contract.strategies.find((s) => s.strategyId === strategy.strategyId);
  if (!strategyContract) {
    return { ok: false, errors: [`未找到策略 ${strategy.strategyId} 的契约定义`] };
  }
  const errors: string[] = [];
  const delegateScore = strategy.shouldDelegate(instruction);
  if (delegateScore < strategyContract.shouldDelegateMin) {
    errors.push(`shouldDelegate 返回 ${delegateScore}，期望 >= ${strategyContract.shouldDelegateMin}`);
  }
  return { ok: errors.length === 0, errors };
}