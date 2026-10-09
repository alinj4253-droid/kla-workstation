/** Storage lifetime, local coverage and recall lifetime are deliberately separate. */
export const SHORT_TERM_CACHE_DAYS = 7;
export const SHORT_TERM_RETENTION_DAYS = 365;
export const SHORT_TERM_HALF_LIFE_HOURS = 72;
export const SHORT_TERM_ZERO_WEIGHT_DAYS = 30;
export const MEMORY_DAY_MS = 86_400_000;
export const SHORT_TERM_KINDS = ['short_term', 'short-term', 'task_summary', 'task_context'] as const;

export function isShortTermMemory(kind: string): boolean {
  return (SHORT_TERM_KINDS as readonly string[]).includes(kind);
}

/** Reads never reinforce a memory; only a new/revised task can change this timestamp. */
export function shortTermTimeWeight(reinforcedAt: string | Date, now = Date.now()): number {
  const timestamp = new Date(reinforcedAt).getTime();
  if (!Number.isFinite(timestamp)) return 0;
  const age = Math.max(0, now - timestamp);
  if (age >= SHORT_TERM_ZERO_WEIGHT_DAYS * MEMORY_DAY_MS) return 0;
  return 2 ** (-age / (SHORT_TERM_HALF_LIFE_HOURS * 3_600_000));
}
