import type { IMemoryRepository } from './repository.js';
import type { MemoryRecallOptions, MemoryRecord, RankedMemory } from './types.js';

const SHORT_TERM_CONSOLIDATION_THRESHOLD = 10;
const LONG_TERM_CONFIDENCE_THRESHOLD = 0.6;
const DEFAULT_EXPIRY_HOURS = 72;
const CONSOLIDATED_EXPIRY_HOURS = 72;
const DEFAULT_SHORT_TERM_HALF_LIFE_HOURS = 72;
const DEFAULT_LONG_TERM_HALF_LIFE_HOURS = 30 * 24;

function queryTokens(query: string): string[] {
  const normalized = query.toLocaleLowerCase('zh-CN').replace(/[\s，。！？、：；,.!?:;"'“”‘’（）()【】\[\]]+/g, '');
  if (!normalized) return [];
  const tokens = new Set<string>();
  for (const part of query.toLocaleLowerCase('zh-CN').split(/[\s，。！？、：；,.!?:;"'“”‘’（）()【】\[\]]+/)) {
    if (part.length >= 2) tokens.add(part.slice(0, 32));
  }
  for (let index = 0; index < normalized.length - 1 && tokens.size < 32; index += 2) {
    tokens.add(normalized.slice(index, index + 2));
  }
  return [...tokens];
}

export function memoryTimeScore(record: MemoryRecord, now = new Date(), shortTermHalfLifeHours = DEFAULT_SHORT_TERM_HALF_LIFE_HOURS, longTermHalfLifeHours = DEFAULT_LONG_TERM_HALF_LIFE_HOURS): number {
  if (record.pinned) return 1;
  const reinforcedAt = Date.parse(record.lastReinforcedAt || record.updatedAt || record.createdAt);
  if (!Number.isFinite(reinforcedAt)) return 0;
  const ageHours = Math.max(0, now.getTime() - reinforcedAt) / 3_600_000;
  const halfLife = record.scope === 'short-term' ? shortTermHalfLifeHours : longTermHalfLifeHours;
  return 2 ** (-ageHours / Math.max(halfLife, 1));
}

export function rankMemories(query: string, records: MemoryRecord[], options: MemoryRecallOptions = {}): RankedMemory[] {
  const now = options.now ?? new Date();
  const tokens = queryTokens(query);
  const minimumScore = options.minimumScore ?? 0.42;
  return records
    .filter((record) => record.status === 'active')
    .filter((record) => record.scope === 'long-term' || !record.expiresAt || Date.parse(record.expiresAt) > now.getTime())
    .map((record) => {
      const content = `${record.topicKey ?? ''} ${record.content}`.toLocaleLowerCase('zh-CN');
      const matched = tokens.filter((token) => content.includes(token)).length;
      const semanticScore = tokens.length > 0 ? matched / tokens.length : 0;
      const timeScore = memoryTimeScore(
        record,
        now,
        options.shortTermHalfLifeHours ?? DEFAULT_SHORT_TERM_HALF_LIFE_HOURS,
        options.longTermHalfLifeHours ?? DEFAULT_LONG_TERM_HALF_LIFE_HOURS,
      );
      const confidence = Math.min(1, Math.max(0, record.confidence));
      const importance = Math.min(1, Math.max(0, record.importance));
      const taskContinuity = semanticScore > 0.5 ? 1 : semanticScore > 0 ? 0.5 : 0;
      const usageScore = Math.min(1, Math.log2(record.accessCount + 1) / 6);
      const score = record.pinned
        ? 1
        : 0.35 * semanticScore + 0.20 * timeScore + 0.15 * confidence + 0.15 * importance + 0.10 * taskContinuity + 0.05 * usageScore;
      return { record, score, semanticScore, timeScore };
    })
    .filter((item) => item.record.pinned || item.score >= minimumScore)
    .sort((left, right) => right.score - left.score)
    .slice(0, options.limit ?? 8);
}

export class MemoryManager {
  constructor(private repo: IMemoryRepository) {}

  buildMemoryContext(projectId: string, agentInstanceId: string): string {
    const all = [
      ...this.repo.list(projectId, agentInstanceId, 'short-term', 'active'),
      ...this.repo.list(projectId, agentInstanceId, 'long-term', 'active'),
    ];
    const ranked = rankMemories('', all, { minimumScore: 0, limit: 8 });
    const shortTerm = ranked.filter((item) => item.record.scope === 'short-term').map((item) => item.record).slice(0, 5);
    const longTerm = ranked.filter((item) => item.record.scope === 'long-term').map((item) => item.record).slice(0, 3);

    const parts: string[] = [];
    if (shortTerm.length > 0) {
      parts.push(
        `最近交互记忆：\n${shortTerm.slice(0, 5).map((m) => `- [${m.type}] ${m.content.slice(0, 300)}`).join('\n')}`,
      );
    }
    if (longTerm.length > 0) {
      parts.push(
        `长期知识：\n${longTerm.slice(0, 3).map((m) => `- ${m.content.slice(0, 500)}`).join('\n')}`,
      );
    }
    return parts.join('\n\n');
  }

  storeShortTerm(
    projectId: string,
    agentInstanceId: string,
    type: string,
    content: string,
    confidence = 0.5,
  ): MemoryRecord {
    return this.repo.create({
      projectId,
      agentInstanceId,
      scope: 'short-term',
      type,
      content,
      confidence,
      importance: confidence,
      lastReinforcedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + DEFAULT_EXPIRY_HOURS * 60 * 60 * 1000).toISOString(),
    });
  }

  consolidateShortTerm(projectId: string, agentInstanceId: string): number {
    const active = this.repo.list(projectId, agentInstanceId, 'short-term', 'active');
    if (active.length < SHORT_TERM_CONSOLIDATION_THRESHOLD) return 0;

    const byType = new Map<string, MemoryRecord[]>();
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
        importance: Math.max(...group.map((m) => m.importance)),
        ...(group[0]?.topicKey ? { topicKey: group[0].topicKey } : {}),
        lastReinforcedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + CONSOLIDATED_EXPIRY_HOURS * 60 * 60 * 1000).toISOString(),
      });

      for (const m of group) {
        this.repo.update(m.id, { status: 'consolidated' });
      }
      consolidated++;
    }
    return consolidated;
  }

  extractLongTerm(projectId: string, agentInstanceId: string): number {
    const active = this.repo.list(projectId, agentInstanceId, 'short-term', 'active');
    const highConfidence = active.filter((m) => m.confidence > LONG_TERM_CONFIDENCE_THRESHOLD);

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
        importance: m.importance,
        ...(m.topicKey ? { topicKey: m.topicKey } : {}),
        lastReinforcedAt: new Date().toISOString(),
        sourceRefsJson: JSON.stringify([m.id]),
      });

      this.repo.update(m.id, { status: 'consolidated' });
      extracted++;
    }
    return extracted;
  }

  recallRelevant(query: string, projectId: string, agentInstanceId: string, limit = 5): string[] {
    const all = [
      ...this.repo.list(projectId, agentInstanceId, 'short-term', 'active'),
      ...this.repo.list(projectId, agentInstanceId, 'long-term', 'active'),
    ];

    const ranked = rankMemories(query, all, { limit });
    this.repo.markAccessed(ranked.map((item) => item.record.id), new Date().toISOString());
    return ranked.map((item) => `[${item.record.scope}][${item.record.type}] ${item.record.content.slice(0, 400)}`);
  }

  expireAll(agentInstanceId: string): void {
    this.repo.expireAll(agentInstanceId);
  }
}
