import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { MemoryRepository } from '@kunqing/database';
import { MemoryManager as CoreMemoryManager } from '@kunqing/memory-core';
import type {
  IMemoryRepository,
  MemoryRecord,
  CreateMemoryInput,
  UpdateMemoryInput,
  MemoryScope,
  MemoryStatus,
} from '@kunqing/memory-core';
import { getProjectRoot } from './paths';
import { getLogger } from './logger';
import type { RoleAdaptationCandidate } from './agent-identity';

const SHORT_TERM_HALF_LIFE_HOURS = 72;
const SHORT_TERM_CONSOLIDATION_COUNT = 5;
const SHORT_TERM_CONSOLIDATION_CHARS = 6_000;
const LONG_TERM_CONFIDENCE_THRESHOLD = 0.6;
const MAX_REQUEST_LENGTH = 1_200;
const MAX_RESULT_LENGTH = 2_400;

class DatabaseMemoryRepository implements IMemoryRepository {
  private repo: MemoryRepository;

  constructor(db: Database.Database) {
    this.repo = new MemoryRepository(db);
  }

  list(projectId: string, agentInstanceId: string, scope?: MemoryScope, status?: MemoryStatus): MemoryRecord[] {
    return this.repo.list(projectId, agentInstanceId, scope, status) as MemoryRecord[];
  }

  get(id: string): MemoryRecord | null {
    return this.repo.get(id) as MemoryRecord | null;
  }

  create(input: CreateMemoryInput): MemoryRecord {
    return this.repo.create(input) as MemoryRecord;
  }

  update(id: string, changes: UpdateMemoryInput): void {
    this.repo.update(id, changes);
  }

  markAccessed(ids: string[], at: string): void {
    this.repo.markAccessed(ids, at);
  }

  remove(id: string): void {
    this.repo.remove(id);
  }

  expireAll(agentInstanceId: string): void {
    this.repo.expireAll(agentInstanceId);
  }
}

export type MemoryReflection = {
  topic: string;
  taskSummary: string;
  decisions: string[];
  reusableInsights: string[];
  preferences: string[];
  constraints: string[];
  unresolved: string[];
  confidence: number;
  importance: number;
  longTermWorth: boolean;
  /** 模型结合近期同主题片段生成的滚动短期摘要。 */
  shortTermSummary?: string;
  /** 模型结合旧长期版本生成的新语义长期摘要。 */
  longTermSummary?: string;
  /** 仅包含跨至少两次独立任务验证过的稳定角色适应项。 */
  roleAdaptations?: RoleAdaptationCandidate[];
};

export type CaptureTurnInput = {
  projectId: string;
  agentInstanceId: string;
  triggerMessageId: string;
  runId: string;
  request: string;
  result: string;
  artifacts?: string[];
  /** 必须由当前智能体自己的运行时生成；缺失时仅保存低置信度短期兜底记录。 */
  reflection?: Partial<MemoryReflection>;
  /** 旧调用兼容；新调用应传 reflection。 */
  selfSummary?: string;
};

const plainInstruction = (input: string): string => {
  try {
    const parsed = JSON.parse(input) as { text?: unknown };
    if (typeof parsed.text === 'string') return parsed.text.trim();
  } catch { /* use original text */ }
  return input.trim();
};

const compact = (value: string, limit: number): string => value.replace(/\s+/g, ' ').trim().slice(0, limit);
const clamp = (value: unknown, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback
);
const stringList = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string').map((item) => compact(item, 500)).filter(Boolean).slice(0, 12)
  : [];
const normalized = (value: string): string => compact(value, 4_000)
  .toLocaleLowerCase('zh-CN')
  .replace(/[\s，。！？、：；,.!?:;"'“”‘’（）()【】\[\]]/g, '');
const safeTopicFile = (value: string): string => value.replace(/[^a-z0-9\u4e00-\u9fff_-]/gi, '-').slice(0, 80) || 'general';

const extractDirective = (text: string, keyword: '记住' | '忘记'): string | null => {
  const match = text.match(new RegExp(`(?:请)?${keyword}[：:，,\\s]*(.+)`, 'is'));
  return match?.[1]?.trim().slice(0, 1_500) || null;
};

function reflectionContent(reflection: MemoryReflection, artifacts: string[]): string {
  const sections = [
    reflection.taskSummary,
    reflection.decisions.length ? `关键决定：${reflection.decisions.join('；')}` : '',
    reflection.reusableInsights.length ? `可复用经验：${reflection.reusableInsights.join('；')}` : '',
    reflection.preferences.length ? `用户偏好：${reflection.preferences.join('；')}` : '',
    reflection.constraints.length ? `约束：${reflection.constraints.join('；')}` : '',
    reflection.unresolved.length ? `待续事项：${reflection.unresolved.join('；')}` : '',
    artifacts.length ? `成果文件：${artifacts.join('、')}` : '',
  ];
  return sections.filter(Boolean).join('\n');
}

export class MemoryManager extends CoreMemoryManager {
  private readonly db: Database.Database;
  private readonly repository: DatabaseMemoryRepository;

  constructor(db: Database.Database) {
    const repository = new DatabaseMemoryRepository(db);
    super(repository);
    this.db = db;
    this.repository = repository;
  }

  /** 为当前智能体的私有回顾步骤提供近期片段和同主题长期版本。 */
  getReflectionContext(projectId: string, agentInstanceId: string): { shortTerm: string[]; longTerm: string[] } {
    this.repository.expireAll(agentInstanceId);
    return {
      shortTerm: this.repository.list(projectId, agentInstanceId, 'short-term', 'active')
        .slice(0, 8)
        .map((item) => `[${item.topicKey ?? item.type}] ${compact(item.content, 700)}`),
      longTerm: this.repository.list(projectId, agentInstanceId, 'long-term', 'active')
        .filter((item) => !item.pinned)
        .slice(0, 6)
        .map((item) => `[${item.topicKey ?? item.type}] ${compact(item.content, 900)}`),
    };
  }

  /**
   * 在用户消息进入调度前处理明确的“记住 / 忘记”指令。
   * 每个群聊智能体得到独立副本；运行时和文件镜像均不跨实例共享。
   */
  async applyUserDirective(projectId: string, rawText: string, triggerMessageId: string): Promise<void> {
    const text = plainInstruction(rawText);
    const remember = extractDirective(text, '记住');
    const forget = extractDirective(text, '忘记');
    if (!remember && !forget) return;

    const agents = this.db.prepare(
      'SELECT id FROM project_agent_instances WHERE project_id = ? ORDER BY ordinal',
    ).all(projectId) as Array<{ id: string }>;
    if (agents.length === 0) return;

    if (forget) {
      const needle = normalized(forget);
      if (needle) {
        for (const agent of agents) {
          const rows = [
            ...this.repository.list(projectId, agent.id, 'short-term', 'active'),
            ...this.repository.list(projectId, agent.id, 'long-term', 'active'),
          ];
          for (const row of rows) {
            const haystack = normalized(`${row.topicKey ?? ''}${row.content}`);
            if (haystack.includes(needle) || needle.includes(haystack)) this.repository.remove(row.id);
          }
          this.upsertTombstone(projectId, agent.id, needle, triggerMessageId, 'explicit-user-forget');
        }
        await Promise.all(agents.map((agent) => this.syncAgentMemory(projectId, agent.id)));
      }
    }

    if (remember) {
      const rememberKey = normalized(remember);
      for (const agent of agents) {
        this.clearMatchingTombstones(projectId, agent.id, rememberKey);
        const existing = this.repository.list(projectId, agent.id, 'long-term', 'active');
        const duplicate = existing.find((item) => item.type === 'project-constraint' && normalized(item.content) === rememberKey);
        if (duplicate) {
          this.repository.update(duplicate.id, {
            confidence: 1,
            importance: 1,
            pinned: true,
            lastReinforcedAt: new Date().toISOString(),
          });
        } else {
          this.repository.create({
            projectId,
            agentInstanceId: agent.id,
            scope: 'long-term',
            type: 'project-constraint',
            content: remember,
            confidence: 1,
            importance: 1,
            pinned: true,
            topicKey: rememberKey.slice(0, 120),
            sourceRefsJson: JSON.stringify({ triggerMessageId, visibility: 'agent', source: 'explicit-user-memory' }),
          });
        }
      }
      await Promise.all(agents.map((agent) => this.syncAgentMemory(projectId, agent.id)));
    }
  }

  /** 保存本智能体的一次任务片段，并按模型判断进行主题压缩和长期语义归纳。 */
  async captureTurn(input: CaptureTurnInput): Promise<MemoryRecord | null> {
    const request = compact(plainInstruction(input.request), MAX_REQUEST_LENGTH);
    const result = compact(input.result, MAX_RESULT_LENGTH);
    if (!request && !result) return null;

    const reflection = this.normalizeReflection(input, request, result);
    const topicKey = normalized(reflection.topic).slice(0, 120) || normalized(request).slice(0, 120) || 'general';
    const artifacts = input.artifacts ?? [];
    const content = reflectionContent(reflection, artifacts);
    if (this.isTombstoned(input.projectId, input.agentInstanceId, `${topicKey}${content}`)) return null;

    const sourceRefsJson = JSON.stringify({
      triggerMessageId: input.triggerMessageId,
      runId: input.runId,
      artifacts,
      visibility: 'agent',
      reflectionSource: input.reflection ? 'agent-runtime' : 'local-fallback',
    });
    const metadataJson = JSON.stringify({
      decisions: reflection.decisions,
      reusableInsights: reflection.reusableInsights,
      preferences: reflection.preferences,
      constraints: reflection.constraints,
      unresolved: reflection.unresolved,
      longTermWorth: reflection.longTermWorth,
    });
    const existing = this.repository.list(input.projectId, input.agentInstanceId, 'short-term', 'active')
      .find((item) => {
        try {
          return (JSON.parse(item.sourceRefsJson ?? '{}') as { runId?: string }).runId === input.runId;
        } catch {
          return false;
        }
      });

    const now = new Date().toISOString();
    let record: MemoryRecord;
    if (existing) {
      this.repository.update(existing.id, {
        content,
        confidence: reflection.confidence,
        importance: reflection.importance,
        topicKey,
        sourceRefsJson,
        metadataJson,
        lastReinforcedAt: now,
        expiresAt: new Date(Date.now() + SHORT_TERM_HALF_LIFE_HOURS * 3_600_000).toISOString(),
      });
      record = this.repository.get(existing.id)!;
    } else {
      record = this.repository.create({
        projectId: input.projectId,
        agentInstanceId: input.agentInstanceId,
        scope: 'short-term',
        type: 'task-episode',
        content,
        confidence: reflection.confidence,
        importance: reflection.importance,
        topicKey,
        sourceRefsJson,
        metadataJson,
        lastReinforcedAt: now,
        expiresAt: new Date(Date.now() + SHORT_TERM_HALF_LIFE_HOURS * 3_600_000).toISOString(),
      });
    }

    await this.consolidateTopic(input, reflection, topicKey);
    this.promoteLongTerm(input, reflection, topicKey, record.id);
    await this.writeSessionMemory(input, content, reflection);
    await this.syncAgentMemory(input.projectId, input.agentInstanceId);
    return record;
  }

  async syncAgentMemory(projectId: string, agentInstanceId: string): Promise<void> {
    try {
      const root = join(getProjectRoot(projectId), 'agent-memories', agentInstanceId);
      const shortDir = join(root, 'short-term');
      const longDir = join(root, 'long-term');
      const shortTopics = join(shortDir, 'topics');
      const longTopics = join(longDir, 'topics');
      await Promise.all([
        mkdir(shortTopics, { recursive: true }),
        mkdir(longTopics, { recursive: true }),
        mkdir(join(root, 'sessions'), { recursive: true }),
      ]);

      this.repository.expireAll(agentInstanceId);
      const shortTerm = this.repository.list(projectId, agentInstanceId, 'short-term', 'active').slice(0, 20);
      const longTerm = this.repository.list(projectId, agentInstanceId, 'long-term', 'active').slice(0, 80);
      const now = new Date().toISOString();
      const shortMarkdown = `---\nschemaVersion: 2\nagentInstanceId: ${agentInstanceId}\nscope: short-term\nupdatedAt: ${now}\n---\n\n# 当前任务记忆\n\n${shortTerm.length ? shortTerm.map((item) => `## ${item.topicKey ?? item.type} · ${item.updatedAt}\n\n${item.content}`).join('\n\n') : '暂无活跃短期记忆。'}\n`;
      const longMarkdown = `---\nschemaVersion: 2\nagentInstanceId: ${agentInstanceId}\nscope: long-term\nupdatedAt: ${now}\n---\n\n# 长期记忆摘要\n\n${longTerm.length ? longTerm.map((item) => `- [${item.pinned ? '固定' : item.type}] ${item.content.replace(/\n/g, ' ')}（置信度 ${Math.round(item.confidence * 100)}%）`).join('\n') : '暂无长期记忆。'}\n`;
      const activeRecords = [...shortTerm, ...longTerm];

      const topicWrites: Array<Promise<void>> = [];
      for (const [scope, directory, records] of [['short-term', shortTopics, shortTerm], ['long-term', longTopics, longTerm]] as const) {
        const grouped = new Map<string, MemoryRecord[]>();
        for (const item of records) {
          const key = item.topicKey ?? item.type;
          grouped.set(key, [...(grouped.get(key) ?? []), item]);
        }
        for (const [topic, items] of grouped) {
          const body = `---\nschemaVersion: 2\nagentInstanceId: ${agentInstanceId}\nscope: ${scope}\ntopic: ${JSON.stringify(topic)}\nupdatedAt: ${now}\n---\n\n# ${topic}\n\n${items.map((item) => item.content).join('\n\n---\n\n')}\n`;
          topicWrites.push(writeFile(join(directory, `${safeTopicFile(topic)}.md`), body, 'utf8'));
        }
      }

      await Promise.all([
        writeFile(join(shortDir, 'current.md'), shortMarkdown, 'utf8'),
        writeFile(join(longDir, 'summary.md'), longMarkdown, 'utf8'),
        writeFile(join(root, 'index.jsonl'), activeRecords.map((item) => JSON.stringify(item)).join('\n') + (activeRecords.length ? '\n' : ''), 'utf8'),
        ...topicWrites,
      ]);
    } catch (err) {
      getLogger()?.warn({ err, projectId, agentInstanceId }, 'MemoryManager: 同步本地记忆文件失败');
    }
  }

  private normalizeReflection(input: CaptureTurnInput, request: string, result: string): MemoryReflection {
    const supplied = input.reflection;
    const legacySummary = compact(input.selfSummary ?? '', 1_800);
    return {
      topic: compact(supplied?.topic ?? request.slice(0, 120) ?? '当前任务', 160) || '当前任务',
      taskSummary: compact(supplied?.taskSummary ?? (legacySummary || `处理了“${request || '当前任务'}”，结果：${result || '无文本结果'}`), 2_000),
      decisions: stringList(supplied?.decisions),
      reusableInsights: stringList(supplied?.reusableInsights),
      preferences: stringList(supplied?.preferences),
      constraints: stringList(supplied?.constraints),
      unresolved: stringList(supplied?.unresolved),
      confidence: clamp(supplied?.confidence, 0.5),
      importance: clamp(supplied?.importance, 0.5),
      longTermWorth: supplied?.longTermWorth === true,
      ...(typeof supplied?.shortTermSummary === 'string' && supplied.shortTermSummary.trim()
        ? { shortTermSummary: compact(supplied.shortTermSummary, 2_400) }
        : {}),
      ...(typeof supplied?.longTermSummary === 'string' && supplied.longTermSummary.trim()
        ? { longTermSummary: compact(supplied.longTermSummary, 2_400) }
        : {}),
    };
  }

  private async consolidateTopic(input: CaptureTurnInput, reflection: MemoryReflection, topicKey: string): Promise<void> {
    const episodes = this.repository.list(input.projectId, input.agentInstanceId, 'short-term', 'active')
      .filter((item) => item.type === 'task-episode' && item.topicKey === topicKey);
    if (episodes.length < SHORT_TERM_CONSOLIDATION_COUNT && episodes.reduce((sum, item) => sum + item.content.length, 0) < SHORT_TERM_CONSOLIDATION_CHARS) return;

    const content = compact(
      reflection.shortTermSummary
        ?? `近期围绕“${reflection.topic}”的工作进展：${episodes.map((item) => item.content).join('；')}`,
      2_800,
    );
    if (this.isTombstoned(input.projectId, input.agentInstanceId, `${topicKey}${content}`)) return;
    const now = new Date().toISOString();
    const summary = this.repository.create({
      projectId: input.projectId,
      agentInstanceId: input.agentInstanceId,
      scope: 'short-term',
      type: 'topic-summary',
      content,
      confidence: reflection.confidence,
      importance: reflection.importance,
      topicKey,
      sourceRefsJson: JSON.stringify(episodes.map((item) => item.id)),
      metadataJson: JSON.stringify({ generatedBy: 'agent-runtime-reflection' }),
      lastReinforcedAt: now,
      expiresAt: new Date(Date.now() + SHORT_TERM_HALF_LIFE_HOURS * 3_600_000).toISOString(),
    });
    for (const episode of episodes) this.repository.update(episode.id, { status: 'consolidated', consolidatedIntoId: summary.id });
  }

  private promoteLongTerm(input: CaptureTurnInput, reflection: MemoryReflection, topicKey: string, sourceId: string): void {
    if (reflection.confidence <= LONG_TERM_CONFIDENCE_THRESHOLD || !reflection.longTermWorth) return;
    const content = compact(reflection.longTermSummary ?? reflectionContent(reflection, input.artifacts ?? []), 3_000);
    if (!content || this.isTombstoned(input.projectId, input.agentInstanceId, `${topicKey}${content}`)) return;
    const previous = this.repository.list(input.projectId, input.agentInstanceId, 'long-term', 'active')
      .find((item) => item.type === 'semantic-summary' && item.topicKey === topicKey);
    const next = this.repository.create({
      projectId: input.projectId,
      agentInstanceId: input.agentInstanceId,
      scope: 'long-term',
      type: 'semantic-summary',
      content,
      confidence: reflection.confidence,
      importance: reflection.importance,
      topicKey,
      sourceRefsJson: JSON.stringify([sourceId, ...(previous ? [previous.id] : [])]),
      metadataJson: JSON.stringify({ generatedBy: 'agent-runtime-reflection', longTermWorth: true }),
      lastReinforcedAt: new Date().toISOString(),
      ...(previous ? { supersedesId: previous.id } : {}),
    });
    if (previous) this.repository.update(previous.id, { status: 'superseded', consolidatedIntoId: next.id });
  }

  private isTombstoned(projectId: string, agentInstanceId: string, value: string): boolean {
    const key = normalized(value);
    if (!key) return false;
    const rows = this.db.prepare(
      'SELECT normalized_key as normalizedKey FROM memory_tombstones WHERE project_id = ? AND agent_instance_id = ?',
    ).all(projectId, agentInstanceId) as Array<{ normalizedKey: string }>;
    return rows.some((row) => key.includes(row.normalizedKey) || row.normalizedKey.includes(key));
  }

  private upsertTombstone(projectId: string, agentInstanceId: string, key: string, sourceMessageId: string, reason: string): void {
    const existing = this.db.prepare(
      'SELECT id FROM memory_tombstones WHERE project_id = ? AND agent_instance_id = ? AND normalized_key = ?',
    ).get(projectId, agentInstanceId, key) as { id: string } | undefined;
    if (existing) return;
    this.db.prepare(
      'INSERT INTO memory_tombstones (id, project_id, agent_instance_id, normalized_key, source_message_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(randomUUID(), projectId, agentInstanceId, key, sourceMessageId, reason, new Date().toISOString());
  }

  private clearMatchingTombstones(projectId: string, agentInstanceId: string, key: string): void {
    const rows = this.db.prepare(
      'SELECT id, normalized_key as normalizedKey FROM memory_tombstones WHERE project_id = ? AND agent_instance_id = ?',
    ).all(projectId, agentInstanceId) as Array<{ id: string; normalizedKey: string }>;
    const remove = this.db.prepare('DELETE FROM memory_tombstones WHERE id = ?');
    for (const row of rows) {
      if (key.includes(row.normalizedKey) || row.normalizedKey.includes(key)) remove.run(row.id);
    }
  }

  private async writeSessionMemory(input: CaptureTurnInput, content: string, reflection: MemoryReflection): Promise<void> {
    try {
      const dir = join(getProjectRoot(input.projectId), 'agent-memories', input.agentInstanceId, 'sessions');
      await mkdir(dir, { recursive: true });
      const safeName = `${input.triggerMessageId}-${input.runId}`.replace(/[^a-z0-9-]/gi, '').slice(0, 96) || input.runId;
      const markdown = `---\nschemaVersion: 2\nprojectId: ${input.projectId}\nagentInstanceId: ${input.agentInstanceId}\ntriggerMessageId: ${input.triggerMessageId}\nrunId: ${input.runId}\ntopic: ${JSON.stringify(reflection.topic)}\nconfidence: ${reflection.confidence}\nimportance: ${reflection.importance}\ncreatedAt: ${new Date().toISOString()}\n---\n\n# 任务回顾\n\n${content}\n`;
      await writeFile(join(dir, `${safeName}.md`), markdown, 'utf8');
    } catch (err) {
      getLogger()?.warn({ err, runId: input.runId }, 'MemoryManager: 写入会话记忆失败');
    }
  }
}
