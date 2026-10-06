import type { Pool } from 'pg';
import type { AccountRepository } from '../repositories/types.js';

/** Persistent agent-loop worker. It resumes pending run steps after restarts. */
export class AgentLoopWorker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private readonly pool: Pool, private readonly accounts: AccountRepository) {}

  start(intervalMs = 750): void { if (this.timer) return; this.timer = setInterval(() => void this.tick(), intervalMs); void this.tick(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private async tick(): Promise<void> {
    if (this.busy) return; this.busy = true;
    try {
      const candidates = await this.pool.query(`SELECT s.id,s.run_id,s.step_index,s.title,s.instruction,s.assigned_agent_id,r.conversation_id FROM conversation_run_steps s JOIN conversation_runs r ON r.id=s.run_id WHERE s.status='pending' AND r.status='running' ORDER BY s.created_at LIMIT 4`);
      for (const step of candidates.rows) await this.executeStep(step);
    } finally { this.busy = false; }
  }

  private async executeStep(step: Record<string, any>): Promise<void> {
    const claimed = await this.pool.query("UPDATE conversation_run_steps SET status='running',updated_at=now() WHERE id=$1 AND status='pending' RETURNING id", [step.id]); if (!claimed.rows[0]) return;
    try {
      const agent = step.assigned_agent_id ? await this.pool.query('SELECT name FROM agents WHERE id=$1', [step.assigned_agent_id]) : null;
      const agentName = agent?.rows[0]?.name ?? '本地执行智能体';
      const text = `已执行步骤 ${step.step_index}：${step.title}${step.instruction ? `\n${step.instruction}` : ''}`;
      await this.accounts.createAgentMessage(step.conversation_id, agentName, text, { runStepId: step.id, stepIndex: step.step_index });
      await this.pool.query("UPDATE conversation_run_steps SET status='completed',result=$2,updated_at=now() WHERE id=$1", [step.id, JSON.stringify({ message: text, agentName })]);
      const next = await this.pool.query("SELECT 1 FROM conversation_run_steps WHERE run_id=$1 AND status IN ('pending','running') LIMIT 1", [step.run_id]);
      if (!next.rows[0]) await this.pool.query("UPDATE conversation_runs SET status='completed',current_agent=$2,updated_at=now() WHERE id=$1 AND status='running'", [step.run_id, agentName]);
    } catch (error) { await this.pool.query("UPDATE conversation_run_steps SET status='failed',result=$2,updated_at=now() WHERE id=$1", [step.id, JSON.stringify({ error: error instanceof Error ? error.message : String(error) })]); await this.pool.query("UPDATE conversation_runs SET status='failed',updated_at=now() WHERE id=$1", [step.run_id]); }
  }
}
