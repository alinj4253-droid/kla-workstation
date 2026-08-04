import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { MemoryRepository } from '@kunqing/database';
import { MemoryManager as CoreMemoryManager } from '@kunqing/memory-core';
import type { IMemoryRepository, MemoryRecord, CreateMemoryInput, UpdateMemoryInput, MemoryScope, MemoryStatus } from '@kunqing/memory-core';
import { getProjectRoot } from './paths';
import { getLogger } from './logger';

const TASK_MEMORY_EXPIRY_DAYS = 7;
const MAX_REQUEST_LENGTH = 800;
const MAX_RESULT_LENGTH = 1_600;

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
    const opts: Record<string, unknown> = {
      projectId: input.projectId,
      agentInstanceId: input.agentInstanceId,
      scope: input.scope,
      type: input.type,
      content: input.content,
    };
    if (input.confidence !== undefined) opts.confidence = input.confidence;
    if (input.sourceRefsJson !== undefined) opts.sourceRefsJson = input.sourceRefsJson;
    if (input.expiresAt !== undefined) opts.expiresAt = input.expiresAt;
    return this.repo.create(opts as any) as MemoryRecord;
  }

  update(id: string, changes: UpdateMemoryInput): void {
    this.repo.update(id, changes as any);
  }

  remove(id: string): void {
    this.repo.remove(id);
  }

  expireAll(agentInstanceId: string): void {
    this.repo.expireAll(agentInstanceId);
  }
}

export type CaptureTurnInput = {
  projectId: string;
  agentInstanceId: string;
  triggerMessageId: string;
  runId: string;
  request: string;
  result: string;
  artifacts?: string[];
  /** 由当前智能体自己的记忆压缩步骤生成，不包含其他智能体私有内容 */
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
const normalized = (value: string): string => compact(value, 4_000).toLocaleLowerCase('zh-CN').replace(/[\s，。！？、：；,.!?:;"'“”‘’（）()【】\[\]]/g, '');

const extractDirective = (text: string, keyword: '记住' | '忘记'): string | null => {
  const match = text.match(new RegExp(`(?:请)?${keyword}[：:，,\\s]*(.+)`, 'is'));
  return match?.[1]?.trim().slice(0, 1_500) || null;
};

export class MemoryManager extends CoreMemoryManager {
  private readonly db: Database.Database;
  private readonly repository: DatabaseMemoryRepository;

  constructor(db: Database.Database) {
    const repository = new DatabaseMemoryRepository(db);
    super(repository);
    this.db = db;
    this.repository = repository;
  }

  /**
   * 在用户消息进入调度前处理明确的“记住 / 忘记”指令。
   * 群聊规则会复制为每个智能体各自拥有的私有长期记忆；运行时仍只能召回本人副本。
   */
  async applyUserDirective(projectId: string, rawText: string, triggerMessageId: string): Promise<void> {
    const text = plainInstruction(rawText);
    const remember = extractDirective(text, '记住');
    const forget = extractDirective(text, '忘记');
    if (!remember && !forget) return;

    const agents = this.db.prepare(
      `SELECT id FROM project_agent_instances WHERE project_id = ? ORDER BY ordinal`,
    ).all(projectId) as Array<{ id: string }>;
    if (agents.length === 0) return;

    if (forget) {
      const needle = normalized(forget);
      if (needle) {
        const rows = this.db.prepare(
          `SELECT id, agent_instance_id as agentInstanceId, content
           FROM memory_records
           WHERE project_id = ? AND scope = 'long-term' AND type = 'project-constraint' AND status = 'active'`,
        ).all(projectId) as Array<{ id: string; agentInstanceId: string; content: string }>;
        const affected = new Set<string>();
        for (const row of rows) {
          const haystack = normalized(row.content);
          if (haystack.includes(needle) || needle.includes(haystack)) {
            this.repository.remove(row.id);
            affected.add(row.agentInstanceId);
          }
        }
        await Promise.all([...affected].map((agentId) => this.syncAgentMemory(projectId, agentId)));
      }
    }

    if (remember) {
      const rememberKey = normalized(remember);
      for (const agent of agents) {
        const existing = this.repository.list(projectId, agent.id, 'long-term', 'active');
        const duplicate = existing.find((item) => item.type === 'project-constraint' && normalized(item.content) === rememberKey);
        if (duplicate) {
          this.repository.update(duplicate.id, { confidence: 1 });
        } else {
          this.repository.create({
            projectId,
            agentInstanceId: agent.id,
            scope: 'long-term',
            type: 'project-constraint',
            content: remember,
            confidence: 1,
            sourceRefsJson: JSON.stringify({ triggerMessageId, visibility: 'agent', source: 'explicit-user-memory' }),
          });
        }
      }
      await Promise.all(agents.map((agent) => this.syncAgentMemory(projectId, agent.id)));
    }
  }

  /** 保存一次可回溯的任务闭环，而不是只保存用户原始输入。 */
  async captureTurn(input: CaptureTurnInput): Promise<MemoryRecord | null> {
    const request = compact(plainInstruction(input.request), MAX_REQUEST_LENGTH);
    const result = compact(input.result, MAX_RESULT_LENGTH);
    if (!request && !result) return null;

    const sourceRefsJson = JSON.stringify({
      triggerMessageId: input.triggerMessageId,
      runId: input.runId,
      artifacts: input.artifacts ?? [],
      visibility: 'agent',
    });
    const existing = this.repository.list(input.projectId, input.agentInstanceId, 'short-term', 'active')
      .find((item) => {
        try {
          const refs = JSON.parse(item.sourceRefsJson ?? '{}') as { runId?: string };
          return refs.runId === input.runId;
        } catch {
          return false;
        }
      });

    const artifactText = input.artifacts?.length ? `\n成果文件：${input.artifacts.join('、')}` : '';
    const autonomousSummary = compact(input.selfSummary ?? '', 1_600);
    const content = autonomousSummary
      ? `自主记忆摘要：${autonomousSummary}${artifactText}`
      : `用户目标：${request || '(无)'}\n执行结果：${result || '(无文本结果)'}${artifactText}`;
    let record: MemoryRecord;
    if (existing) {
      this.repository.update(existing.id, { content, confidence: 0.68 });
      record = this.repository.get(existing.id)!;
    } else {
      record = this.repository.create({
        projectId: input.projectId,
        agentInstanceId: input.agentInstanceId,
        scope: 'short-term',
        type: 'task-summary',
        content,
        confidence: 0.68,
        sourceRefsJson,
        expiresAt: new Date(Date.now() + TASK_MEMORY_EXPIRY_DAYS * 24 * 60 * 60 * 1_000).toISOString(),
      });
    }

    await this.writeSessionMemory(input, content);
    await this.syncAgentMemory(input.projectId, input.agentInstanceId);
    return record;
  }

  async syncAgentMemory(projectId: string, agentInstanceId: string): Promise<void> {
    try {
      const root = join(getProjectRoot(projectId), 'agent-memories', agentInstanceId);
      const shortDir = join(root, 'short-term');
      const longDir = join(root, 'long-term');
      await Promise.all([mkdir(shortDir, { recursive: true }), mkdir(longDir, { recursive: true }), mkdir(join(root, 'sessions'), { recursive: true })]);

      const shortTerm = this.repository.list(projectId, agentInstanceId, 'short-term', 'active')
        .filter((item) => !item.expiresAt || item.expiresAt > new Date().toISOString())
        .slice(0, 12);
      const longTerm = this.repository.list(projectId, agentInstanceId, 'long-term', 'active').slice(0, 50);
      const now = new Date().toISOString();
      const shortMarkdown = `---\nschemaVersion: 1\nagentInstanceId: ${agentInstanceId}\nscope: short-term\nupdatedAt: ${now}\n---\n\n# 当前任务记忆\n\n${shortTerm.length ? shortTerm.map((item) => `## ${item.type} · ${item.updatedAt}\n\n${item.content}`).join('\n\n') : '暂无活跃短期记忆。'}\n`;
      const longMarkdown = `---\nschemaVersion: 1\nagentInstanceId: ${agentInstanceId}\nscope: long-term\nupdatedAt: ${now}\n---\n\n# 长期记忆摘要\n\n${longTerm.length ? longTerm.map((item) => `- [${item.type}] ${item.content.replace(/\n/g, ' ')}（置信度 ${Math.round(item.confidence * 100)}%）`).join('\n') : '暂无长期记忆。'}\n`;
      const activeRecords = [...shortTerm, ...longTerm];

      await Promise.all([
        writeFile(join(shortDir, 'current.md'), shortMarkdown, 'utf8'),
        writeFile(join(longDir, 'summary.md'), longMarkdown, 'utf8'),
        writeFile(join(root, 'index.jsonl'), activeRecords.map((item) => JSON.stringify(item)).join('\n') + (activeRecords.length ? '\n' : ''), 'utf8'),
      ]);
    } catch (err) {
      getLogger()?.warn({ err, projectId, agentInstanceId }, 'MemoryManager: 同步本地记忆文件失败');
    }
  }

  private async writeSessionMemory(input: CaptureTurnInput, content: string): Promise<void> {
    try {
      const dir = join(getProjectRoot(input.projectId), 'agent-memories', input.agentInstanceId, 'sessions');
      await mkdir(dir, { recursive: true });
      const safeName = `${input.triggerMessageId}-${input.runId}`.replace(/[^a-z0-9-]/gi, '').slice(0, 96) || input.runId;
      const markdown = `---\nschemaVersion: 1\nprojectId: ${input.projectId}\nagentInstanceId: ${input.agentInstanceId}\ntriggerMessageId: ${input.triggerMessageId}\nrunId: ${input.runId}\ncreatedAt: ${new Date().toISOString()}\n---\n\n# 任务闭环\n\n${content}\n`;
      await writeFile(join(dir, `${safeName}.md`), markdown, 'utf8');
    } catch (err) {
      getLogger()?.warn({ err, runId: input.runId }, 'MemoryManager: 写入会话记忆失败');
    }
  }
}
