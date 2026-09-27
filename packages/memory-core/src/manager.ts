import type { IMemoryRepository } from './repository.js';
import type { MemoryRecallOptions, MemoryRecord, RankedMemory } from './types.js';

const SHORT_TERM_CONSOLIDATION_THRESHOLD = 10;
const LONG_TERM_CONFIDENCE_THRESHOLD = 0.6;
const DEFAULT_EXPIRY_HOURS = 72;
const CONSOLIDATED_EXPIRY_HOURS = 72;
const DEFAULT_SHORT_TERM_HALF_LIFE_HOURS = 72;
const DEFAULT_LONG_TERM_HALF_LIFE_HOURS = 30 * 24;
/** 单次召回的候选池上限（每个 scope）：控制查询与评分规模，置顶记忆不受此限制。 */
const RECALL_CANDIDATE_LIMIT = 40;

/** 查询分词缓存：同一查询文本在一次响应内可能被多次评分（召回、构建上下文）。 */
const queryTokenCache = new Map<string, string[]>();
const QUERY_TOKEN_CACHE_MAX = 64;
/** 2-gram 只对前 256 个字符滑窗，防止超长查询产生无界的切片与匹配成本。 */
const QUERY_GRAM_SOURCE_MAX = 256;

function queryTokens(query: string): string[] {
  const cached = queryTokenCache.get(query);
  if (cached) return cached;
  const lowered = query.toLocaleLowerCase('zh-CN');
  const normalized = lowered.replace(/[\s，。！？、：；,.!?:;"'“”‘’（）()【】\[\]]+/g, '');
  const tokens = new Set<string>();
  if (normalized) {
    for (const part of lowered.split(/[\s，。！？、：；,.!?:;"'“”‘’（）()【】\[\]]+/)) {
      if (part.length >= 2) tokens.add(part.slice(0, 32));
    }
    const gramSource = normalized.slice(0, QUERY_GRAM_SOURCE_MAX);
    for (let index = 0; index < gramSource.length - 1 && tokens.size < 32; index += 2) {
      tokens.add(gramSource.slice(index, index + 2));
    }
  }
  const result = [...tokens];
  if (queryTokenCache.size >= QUERY_TOKEN_CACHE_MAX) {
    const oldest = queryTokenCache.keys().next().value;
    if (oldest !== undefined) queryTokenCache.delete(oldest);
  }
  queryTokenCache.set(query, result);
  return result;
}

/** 记录归一化文本缓存：markAccessed 不改 updated_at，按 id+updatedAt+长度失效即可安全复用。 */
const normalizedContentCache = new Map<string, { stamp: string; text: string }>();
const NORMALIZED_CONTENT_CACHE_MAX = 512;

function normalizedMemoryText(record: MemoryRecord): string {
  const stamp = `${record.updatedAt}:${record.content.length}`;
  const cached = normalizedContentCache.get(record.id);
  if (cached && cached.stamp === stamp) return cached.text;
  const text = `${record.topicKey ?? ''} ${record.content}`.toLocaleLowerCase('zh-CN');
  if (normalizedContentCache.size >= NORMALIZED_CONTENT_CACHE_MAX) {
    const oldest = normalizedContentCache.keys().next().value;
    if (oldest !== undefined) normalizedContentCache.delete(oldest);
  }
  normalizedContentCache.set(record.id, { stamp, text });
  return text;
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
      const content = normalizedMemoryText(record);
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

  /**
   * 拉取召回候选：每个 scope 只取最新 RECALL_CANDIDATE_LIMIT 条，让评分成本
   * 与历史记忆总量解耦；置顶记忆单独全量合并，不受 LIMIT 裁剪影响。
   */
  private listRecallCandidates(projectId: string, agentInstanceId: string): MemoryRecord[] {
    const merged = new Map<string, MemoryRecord>();
    for (const scope of ['short-term', 'long-term'] as const) {
      const recent = this.repo.list(projectId, agentInstanceId, scope, 'active', { limit: RECALL_CANDIDATE_LIMIT });
      const pinned = this.repo.list(projectId, agentInstanceId, scope, 'active', { pinnedOnly: true });
      for (const item of [...recent, ...pinned]) merged.set(item.id, item);
    }
    return [...merged.values()];
  }

  buildMemoryContext(projectId: string, agentInstanceId: string): string {
    const all = this.listRecallCandidates(projectId, agentInstanceId);
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
    if (highConfidence.length === 0) return 0;

    // 循环外一次性拉取长期记忆并建去重索引，避免每条候选都全量重查（O(n*m) → O(n+m)）。
    const duplicateKeys = new Set(
      this.repo.list(projectId, agentInstanceId, 'long-term', 'active')
        .map((e) => `${e.type}\n${e.content.slice(0, 50)}`),
    );

    let extracted = 0;
    for (const m of highConfidence) {
      const key = `${m.type}\n${m.content.slice(0, 50)}`;
      if (duplicateKeys.has(key)) continue;
      duplicateKeys.add(key);

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
    const all = this.listRecallCandidates(projectId, agentInstanceId);

    const ranked = rankMemories(query, all, { limit });
    this.repo.markAccessed(ranked.map((item) => item.record.id), new Date().toISOString());
    return ranked.map((item) => `[${item.record.scope}][${item.record.type}] ${item.record.content.slice(0, 400)}`);
  }

  expireAll(agentInstanceId: string): void {
    this.repo.expireAll(agentInstanceId);
  }
}
