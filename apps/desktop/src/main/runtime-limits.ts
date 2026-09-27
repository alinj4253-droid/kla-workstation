import type Database from 'better-sqlite3';

/**
 * Runtime / scheduling limits, configurable via the `settings` table so that
 * operators can tune them without a rebuild. All values fall back to safe
 * defaults when unset or invalid (wrapping `{ value: number }` like the rest
 * of the settings layer).
 */

export const DEFAULT_MAX_CONCURRENT_RUNS = 12;
export const DEFAULT_MAX_AGENTS_PER_PROJECT = 9;
export const DEFAULT_MAX_RUNS_PER_TRIGGER = 64;
export const DEFAULT_AGENT_TASK_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
export const DEFAULT_MAX_PARALLEL_SPAWN = 6;

type NumericSettingName =
  | 'runtime.maxConcurrentRuns'
  | 'runtime.maxAgentsPerProject'
  | 'runtime.maxRunsPerTrigger'
  | 'runtime.agentTaskTimeoutMinutes'
  | 'runtime.maxParallelSpawn';

function readNumericSetting(db: Database.Database, key: NumericSettingName): number | null {
  try {
    const row = db.prepare('SELECT value_json as valueJson FROM settings WHERE key = ?').get(key) as { valueJson: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.valueJson) as { value?: unknown };
    const numeric = Number(parsed.value);
    return Number.isFinite(numeric) ? numeric : null;
  } catch {
    return null;
  }
}

function clampInt(value: number | null, min: number, max: number, fallback: number): number {
  if (value === null || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  return Math.max(min, Math.min(max, rounded));
}

export interface RuntimeLimits {
  maxConcurrentRuns: number;
  maxAgentsPerProject: number;
  maxRunsPerTrigger: number;
  agentTaskTimeoutMs: number;
  maxParallelSpawn: number;
}

/** Resolve all tunable runtime limits for the given database (defaults when unset). */
export function resolveRuntimeLimits(db: Database.Database): RuntimeLimits {
  const maxConcurrentRuns = clampInt(readNumericSetting(db, 'runtime.maxConcurrentRuns'), 1, 16, DEFAULT_MAX_CONCURRENT_RUNS);
  const maxAgentsPerProject = clampInt(readNumericSetting(db, 'runtime.maxAgentsPerProject'), 1, 50, DEFAULT_MAX_AGENTS_PER_PROJECT);
  const maxRunsPerTrigger = clampInt(readNumericSetting(db, 'runtime.maxRunsPerTrigger'), 1, 256, DEFAULT_MAX_RUNS_PER_TRIGGER);
  const timeoutMinutes = readNumericSetting(db, 'runtime.agentTaskTimeoutMinutes');
  const agentTaskTimeoutMs = clampInt(
    timeoutMinutes === null ? null : timeoutMinutes * 60_000,
    60_000,
    4 * 60 * 60 * 1_000,
    DEFAULT_AGENT_TASK_TIMEOUT_MS,
  );
  const maxParallelSpawn = clampInt(readNumericSetting(db, 'runtime.maxParallelSpawn'), 1, 12, DEFAULT_MAX_PARALLEL_SPAWN);
  return { maxConcurrentRuns, maxAgentsPerProject, maxRunsPerTrigger, agentTaskTimeoutMs, maxParallelSpawn };
}

/** Convenience single-value accessor (kept for callers that only need one limit). */
export function resolveMaxConcurrentRuns(db: Database.Database | null): number {
  if (!db) return DEFAULT_MAX_CONCURRENT_RUNS;
  return resolveRuntimeLimits(db).maxConcurrentRuns;
}
