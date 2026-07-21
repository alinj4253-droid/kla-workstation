import type Database from 'better-sqlite3';
import { MemoryRepository } from '@kunqing/database';

const SHORT_TERM_CONSOLIDATION_THRESHOLD = 10;
const LONG_TERM_CONFIDENCE_THRESHOLD = 0.7;

export class MemoryManager {
  private repo: MemoryRepository;

  constructor(private db: Database.Database) {
    this.repo = new MemoryRepository(db);
  }

  buildMemoryContext(projectId: string, agentInstanceId: string): string {
    const shortTerm = this.repo.list(projectId, agentInstanceId, 'short-term', 'active');
    const longTerm = this.repo.list(projectId, agentInstanceId, 'long-term', 'active');

    const parts: string[] = [];
    if (shortTerm.length > 0) {
      parts.push(`最近交互记忆：\n${shortTerm.slice(0, 5).map((m) => `- [${m.type}] ${m.content.slice(0, 300)}`).join('\n')}`);
    }
    if (longTerm.length > 0) {
      parts.push(`长期知识：\n${longTerm.slice(0, 3).map((m) => `- ${m.content.slice(0, 500)}`).join('\n')}`);
    }
    return parts.join('\n\n');
  }

  storeShortTerm(projectId: string, agentInstanceId: string, type: string, content: string, confidence = 0.5): void {
    this.repo.create({
      projectId,
      agentInstanceId,
      scope: 'short-term',
      type,
      content,
      confidence,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  }

  consolidateShortTerm(projectId: string, agentInstanceId: string): number {
    const active = this.repo.list(projectId, agentInstanceId, 'short-term', 'active');
    if (active.length < SHORT_TERM_CONSOLIDATION_THRESHOLD) return 0;

    const byType = new Map<string, typeof active>();
    for (const m of active) {
      const list = byType.get(m.type) ?? [];
      list.push(m);
      byType.set(m.type, list);
    }

    let consolidated = 0;
    for (const [, group] of byType) {
      if (group.length < 3) continue;
      const merged = group.map((m) => m.content).join('\n').slice(0, 1000);
      const avgConfidence = group.reduce((s, m) => s + m.confidence, 0) / group.length;

      const firstType = group[0]?.type ?? 'unknown';
      this.repo.create({
        projectId,
        agentInstanceId,
        scope: 'short-term',
        type: `merged:${firstType}`,
        content: merged,
        confidence: avgConfidence,
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      });

      for (const m of group) {
        this.repo.update(m.id, { status: 'expired' });
      }
      consolidated++;
    }
    return consolidated;
  }

  extractLongTerm(projectId: string, agentInstanceId: string): number {
    const active = this.repo.list(projectId, agentInstanceId, 'short-term', 'active');
    const highConfidence = active.filter((m) => m.confidence >= LONG_TERM_CONFIDENCE_THRESHOLD);

    let extracted = 0;
    for (const m of highConfidence) {
      const existing = this.repo.list(projectId, agentInstanceId, 'long-term', 'active');
      const isDuplicate = existing.some(
        (e) => e.type === m.type && e.content.slice(0, 50) === m.content.slice(0, 50),
      );
      if (isDuplicate) continue;

      this.repo.create({
        projectId,
        agentInstanceId,
        scope: 'long-term',
        type: m.type,
        content: m.content,
        confidence: m.confidence,
        sourceRefsJson: JSON.stringify([m.id]),
      });

      this.repo.update(m.id, { status: 'expired' });
      extracted++;
    }
    return extracted;
  }

  recallRelevant(query: string, projectId: string, agentInstanceId: string, limit = 5): string[] {
    const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    const all = this.repo.list(projectId, agentInstanceId, 'short-term', 'active')
      .concat(this.repo.list(projectId, agentInstanceId, 'long-term', 'active'));

    const scored = all.map((m) => {
      const lower = m.content.toLowerCase();
      const score = keywords.filter((k) => lower.includes(k)).length / keywords.length;
      return { record: m, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => `[${s.record.scope}][${s.record.type}] ${s.record.content.slice(0, 400)}`);
  }
}
