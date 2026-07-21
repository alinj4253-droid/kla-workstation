import type Database from 'better-sqlite3';
import { MemoryRepository } from '@kunqing/database';

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export function startMemoryCleanup(db: Database.Database): () => void {
  const repo = new MemoryRepository(db);

  const tick = (): void => {
    try {
      const pairs = db.prepare(
        `SELECT DISTINCT project_id, agent_instance_id FROM memory_records WHERE scope = 'short-term' AND status = 'active'`,
      ).all() as Array<{ project_id: string; agent_instance_id: string }>;

      for (const p of pairs) {
        repo.expireAll(p.agent_instance_id);
      }
    } catch {
      // silent
    }
  };

  tick();
  const timer = setInterval(tick, CLEANUP_INTERVAL_MS);

  return () => clearInterval(timer);
}
