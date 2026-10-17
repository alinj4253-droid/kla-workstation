import type { Pool } from 'pg';
import { MEMORY_DAY_MS, SHORT_TERM_RETENTION_DAYS, shortTermTimeWeight } from '@kla-workstation/contracts';

type Candidate = {
  id: string; content: string; last_reinforced_at: Date; confidence: number;
  importance: number; access_count: number;
};
export type AgentMemoryScope = { identityId: string; conversationId: string; agentId: string };

export function memoryTokens(query: string): string[] {
  const source = query.toLowerCase().slice(0, 256);
  const words = source.match(/[a-z0-9_]+/g) ?? [];
  const pairs = (source.match(/[\u4e00-\u9fff]+/g) ?? []).flatMap(word =>
    Array.from({ length: Math.max(0, word.length - 1) }, (_, i) => word.slice(i, i + 2))).slice(0, 32);
  return [...new Set([...words, ...pairs])];
}

/** The old bounded recall formula, with a hard zero-age cutoff before ranking. */
export function rankShortTerm(candidates: Candidate[], query: string, now = Date.now()): Candidate[] {
  const tokens = memoryTokens(query);
  return candidates.map(candidate => {
    const time = shortTermTimeWeight(candidate.last_reinforced_at, now);
    const content = candidate.content.toLowerCase();
    const semantic = tokens.length ? tokens.filter(token => content.includes(token)).length / tokens.length : 0;
    const continuity = semantic > 0.5 ? 1 : semantic > 0 ? 0.5 : 0;
    const bounded = (n: number) => Math.max(0, Math.min(1, n));
    const score = 0.35 * semantic + 0.2 * time + 0.15 * bounded(candidate.confidence)
      + 0.15 * bounded(candidate.importance) + 0.1 * continuity
      + 0.05 * Math.min(1, Math.log2(Math.max(0, candidate.access_count) + 1) / 6);
    return { candidate, score, time };
  }).filter(item => item.time > 0 && item.score >= (tokens.length ? 0.42 : 0.52))
    .sort((a, b) => b.score - a.score).slice(0, 3).map(item => item.candidate);
}

export class ShortTermMemoryService {
  constructor(private readonly pool: Pool) {}

  async recall(scope: AgentMemoryScope, query: string, now = Date.now()): Promise<string[]> {
    const result = await this.pool.query<Candidate>(`SELECT m.id,m.content,m.last_reinforced_at,m.confidence,m.importance,m.access_count
      FROM memories m JOIN workspaces w ON w.id=m.workspace_id AND w.identity_id=$1
      JOIN conversations c ON c.id=$2 JOIN projects p ON p.id=c.project_id AND p.owner_identity_id=$1
      JOIN agents a ON a.id=$3::uuid AND (a.identity_id=$1 OR (a.identity_id IS NULL AND a.type='official'))
      WHERE COALESCE(m.metadata->>'conversationId',m.metadata->>'chatId')=c.id::text
        AND (COALESCE(m.metadata->>'agentId',m.metadata->>'sourceAgentId')=$3::text
          OR (COALESCE(m.metadata->>'agentId',m.metadata->>'sourceAgentId') IS NULL
            AND COALESCE(m.metadata->>'diagnosisPrivate','false')<>'true'
            AND COALESCE(m.metadata->>'agentName',m.metadata->>'sourceAgentName')=a.name))
        AND (w.project_id IS NULL OR w.project_id=p.id)
        AND (m.metadata->>'projectId' IS NULL OR m.metadata->>'projectId'=p.id::text)
        AND m.kind IN ('short_term','short-term','task_summary','task_context')
        AND m.retained_until>$4 AND (m.expires_at IS NULL OR m.expires_at>$4)
        AND m.last_reinforced_at>$4::timestamptz-interval '30 days'
      ORDER BY m.last_reinforced_at DESC,m.id DESC LIMIT 40`,
    [scope.identityId, scope.conversationId, scope.agentId, new Date(now)]);
    const selected = rankShortTerm(result.rows, query, now);
    if (selected.length) await this.pool.query(`UPDATE memories SET access_count=access_count+1,last_accessed_at=$2
      WHERE id=ANY($1::uuid[])`, [selected.map(item => item.id), new Date(now)]);
    return selected.map(item => item.content.slice(0, 400));
  }

  /** Shared user input + this agent's messages, bounded at the triggering message. */
  async history(scope: AgentMemoryScope, triggerMessageId: string): Promise<Array<{ role: string; content: string }>> {
    const result = await this.pool.query<{ sender_type: string; text: string }>(`SELECT m.sender_type,m.text FROM messages m
      JOIN conversations c ON c.id=m.conversation_id JOIN projects p ON p.id=c.project_id AND p.owner_identity_id=$1
      JOIN messages trigger ON trigger.id=$4 AND trigger.conversation_id=c.id
      JOIN agents a ON a.id=$3::uuid AND (a.identity_id=$1 OR (a.identity_id IS NULL AND a.type='official'))
      WHERE c.id=$2 AND m.created_at<=trigger.created_at
        AND m.created_at>now()-interval '30 days'
        AND (m.sender_type='user' OR (m.sender_type='agent' AND (m.metadata->>'agentId'=$3::text
          OR (m.metadata->>'agentId' IS NULL AND COALESCE(m.metadata->>'diagnosisPrivate','false')<>'true' AND m.sender_name=(SELECT name FROM agents WHERE id=$3::uuid)))))
      ORDER BY m.created_at DESC,m.id DESC LIMIT 12`, [scope.identityId, scope.conversationId, scope.agentId, triggerMessageId]);
    return result.rows.reverse().map(row => ({ role: row.sender_type === 'agent' ? 'assistant' : 'user', content: row.text.slice(0, 6000) }));
  }

  async capture(scope: AgentMemoryScope, input: { runId: string; agentName: string; request: string; answer: string; sourceMessageId: string }): Promise<void> {
    // One SQL statement verifies ownership and uses the migration's partial unique index for retries.
    await this.pool.query(`INSERT INTO memories(workspace_id,content,kind,metadata)
      SELECT w.id,$4,'task_summary',jsonb_build_object('conversationId',c.id::text,'projectId',p.id::text,
        'agentId',$3::text,'agentName',$5::text,'runId',$6::text,'sourceMessageId',$7::text,'captureVersion','1')
      FROM conversations c JOIN projects p ON p.id=c.project_id AND p.owner_identity_id=$1
      JOIN LATERAL (SELECT id FROM workspaces WHERE identity_id=$1 AND (project_id=p.id OR (type='personal' AND project_id IS NULL))
        ORDER BY (project_id=p.id) DESC NULLS LAST,id LIMIT 1) w ON true
      JOIN agents a ON a.id=$3::uuid AND (a.identity_id=$1 OR (a.identity_id IS NULL AND a.type='official'))
      WHERE c.id=$2 ON CONFLICT DO NOTHING`, [scope.identityId, scope.conversationId, scope.agentId,
      `处理了“${input.request.slice(0, 1200)}”，结果：${input.answer.slice(0, 2400)}`,
      input.agentName, input.runId, input.sourceMessageId]);
  }

  async prune(now = Date.now()): Promise<number> {
    const result = await this.pool.query(`DELETE FROM memories WHERE id IN (SELECT id FROM memories
      WHERE kind IN ('short_term','short-term','task_summary','task_context')
        AND created_at<=$1::timestamptz-interval '365 days' ORDER BY created_at LIMIT 1000)`, [new Date(now)]);
    return result.rowCount ?? 0;
  }
}

export const shortTermRetainedUntil = (createdAt: string) => new Date(Date.parse(createdAt) + SHORT_TERM_RETENTION_DAYS * MEMORY_DAY_MS).toISOString();

export class MemoryRetentionWorker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  constructor(private readonly memory: ShortTermMemoryService, private readonly onError: (error: unknown) => void) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 3_600_000);
    this.timer.unref(); this.tick();
  }
  private tick(): void {
    if (this.running) return;
    this.running = (async () => {
      // Drain a bounded backlog without monopolizing the DB pool.
      for (let batch = 0; batch < 10; batch++) if (await this.memory.prune() < 1000) break;
    })().catch(this.onError).finally(() => { this.running = null; });
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = null; await this.running; }
}
