import { describe, expect, it } from 'vitest';
import { isShortTermMemory, MEMORY_DAY_MS, shortTermTimeWeight } from './memory-policy.js';

describe('short-term time policy', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  it('keeps fresh weights, halves every 72 hours and cuts off at 30 days', () => {
    expect(shortTermTimeWeight(new Date(now), now)).toBe(1);
    expect(shortTermTimeWeight(new Date(now - 3 * MEMORY_DAY_MS), now)).toBe(0.5);
    expect(shortTermTimeWeight(new Date(now - 29 * MEMORY_DAY_MS), now)).toBeGreaterThan(0);
    expect(shortTermTimeWeight(new Date(now - 30 * MEMORY_DAY_MS), now)).toBe(0);
    expect(shortTermTimeWeight(new Date(now + MEMORY_DAY_MS), now)).toBe(1);
    expect(shortTermTimeWeight('invalid', now)).toBe(0);
  });
  it('recognizes legacy short-term kinds without treating long-term as decaying', () => {
    expect(['short_term', 'short-term', 'task_summary', 'task_context'].every(isShortTermMemory)).toBe(true);
    expect(isShortTermMemory('long_term')).toBe(false);
  });
});
