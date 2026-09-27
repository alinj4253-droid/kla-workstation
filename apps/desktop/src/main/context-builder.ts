import { writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ProjectRepository, SearchRepository, AgentRunRepository, FileRepository } from '@kunqing/database';
import type { ProjectRow } from '@kunqing/database';
import { rankMemories, type MemoryRecord } from '@kunqing/memory-core';
import { getLogger } from './logger';
import { getProjectRoot } from './paths';
import { SkillRegistry } from './skill-registry';
import { WorkflowRegistry } from './workflow-registry';
import { loadAgentDefinitionText } from './agent-identity';
import { getEnterpriseProject } from './enterprise-project-workspace';
import { resolveKnowledgeScopesForGroup } from './knowledge-sync';
import { selectTaskContext, type TaskContextMessageRow, type TaskMessageRelation } from './task-context';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ContextSnapshot = {
  /** 版本的 hash，用于校验一致性 */
  snapshotChecksum: string;
  /** 构建时间戳 */
  builtAt: string;

  // ── 项目信息 ──────────────────────────────────────────────────────────────
  project: {
    id: string;
    name: string;
    summary: string;
    sharedKnowledgeEnabled: boolean;
  };

  /** 当前群聊经过项目关联权限计算后实际可读取的知识范围。 */
  knowledgeAccess: {
    personal: { scopeType: 'project'; scopeId: string; label: string };
    project: { scopeType: 'project'; scopeId: string; label: string; name: string } | null;
    enterprise: { scopeType: 'shared'; scopeId: string; label: string };
  };

  // ── 当前智能体信息 ─────────────────────────────────────────────────────────
  agent: {
    instanceId: string;
    profileName: string;
    role: string;
    definitionId: string;
    definitionVersion: string;
    definitionSystemPrompt: string | null;
    identity: string | null;
    permissions: string[];
  };

  /** 当前 Agent Definition 可用的技能目录；正文通过 skill:load 按需加载。 */
  skills: Array<{
    id: string;
    version: string;
    name: string;
    description: string;
    requiredTools: string[];
  }>;

  /** 业务级协同工作流目录，仅绑定到相应 Agent Definition。 */
  workflows: Array<{
    id: string;
    version: string;
    name: string;
    description: string;
  }>;

  // ── 群聊成员 ──────────────────────────────────────────────────────────────
  members: Array<{
    instanceId: string;
    name: string;
    role: string;
  }>;

  // ── 最近消息 ──────────────────────────────────────────────────────────────
  messages: Array<{
    id: string;
    senderType: string;
    senderId: string;
    content: string;
    replyToId: string | null;
    createdAt: string;
    taskRelation?: TaskMessageRelation;
  }>;
  /** 如果消息超过预算，更早的消息以滚动摘要替代 */
  rollingSummary: string | null;

  // ── 记忆 ──────────────────────────────────────────────────────────────────
  memory: {
    shortTerm: string[];
    longTerm: string[];
  };

  // ── 引用文件 ──────────────────────────────────────────────────────────────
  referencedFiles: Array<{
    fileId: string;
    name: string;
    path: string;
  }>;

  // ── 父 Run 结果 ───────────────────────────────────────────────────────────
  parentRunResult: string | null;

  // ── 知识片段 ──────────────────────────────────────────────────────────────
  knowledgeChunks: Array<{
    sourceId: string;
    text: string;
    sourceLabel: string;
  }>;

  // ── 工作区规则 ────────────────────────────────────────────────────────────
  workspace: {
    rootPath: string;
    allowedRoots: string[];
    publishMethod: string;
  };
};

export type ContextBuilderOptions = {
  /** 最多包含的最近消息数（默认 8） */
  recentMessageLimit?: number;
  /** 知识片段最大数量（默认 4） */
  knowledgeChunkLimit?: number;
  /** 共享知识片段最大数量（默认 2） */
  sharedKnowledgeChunkLimit?: number;
};

/**
 * 快照构建范围：
 * - all：完整快照（含知识检索、引用文件、成员等全部段落）；
 * - core：仅构建直接执行模式实际使用的段落（agent / messages / memory / workspace），
 *   跳过知识 LIKE 检索等重查询，避免快路径上的无谓成本。
 */
export type ContextBuildSections = 'all' | 'core';

// ─── Manifest 条目类型 ───────────────────────────────────────────────────────

export type ManifestEntry = {
  sourceId: string;
  checksum: string;
  /** 条目类型：消息 / 附件 / 知识片段 / 身份摘要 / 记忆 / 父任务结果 */
  category: 'message' | 'attachment' | 'knowledge' | 'identity' | 'memory' | 'parent_run';
  /** 条目内容摘要（前 200 字符） */
  summary: string;
};

export type ContextManifest = {
  manifestVersion: 1;
  builtAt: string;
  snapshotChecksum: string;
  entries: ManifestEntry[];
};

// ─── ContextBuilder ──────────────────────────────────────────────────────────

export class ContextBuilder {
  private db: Database.Database;
  private projectRepo: ProjectRepository;
  private searchRepo: SearchRepository;
  private runRepo: AgentRunRepository;
  private fileRepo: FileRepository;
  private options: Required<ContextBuilderOptions>;

  constructor(db: Database.Database, options?: ContextBuilderOptions) {
    this.db = db;
    this.projectRepo = new ProjectRepository(db);
    this.searchRepo = new SearchRepository(db);
    this.runRepo = new AgentRunRepository(db);
    this.fileRepo = new FileRepository(db);
    this.options = {
      recentMessageLimit: options?.recentMessageLimit ?? 8,
      knowledgeChunkLimit: options?.knowledgeChunkLimit ?? 4,
      sharedKnowledgeChunkLimit: options?.sharedKnowledgeChunkLimit ?? 2,
    };
  }

  /**
   * 为指定 Run 构建不可变 ContextSnapshot
   * @param options.sections 构建范围，默认 all；core 供直接模式等只消费
   *   agent/messages/memory/workspace 的调用方跳过重查询。
   */
  build(projectId: string, agentInstanceId: string, triggerMessageId?: string, parentRunId?: string, options?: { sections?: ContextBuildSections }): ContextSnapshot {
    const logger = getLogger();
    const sections = options?.sections ?? 'all';
    const coreOnly = sections === 'core';
    logger?.info({ projectId, agentInstanceId, sections }, 'ContextBuilder: 开始构建上下文快照');

    // ── 项目信息 ─────────────────────────────────────────────────────────
    let project: ProjectRow;
    try {
      project = this.projectRepo.getById(projectId);
    } catch {
      project = { id: projectId, name: '未知项目', status: 'active', summary: '', lastActiveAt: '', createdAt: '', sharedKnowledgeEnabled: true };
    }

    const projectInfo: ContextSnapshot['project'] = {
      id: project.id,
      name: project.name,
      summary: project.summary ?? '',
      sharedKnowledgeEnabled: true,
    };

    // ── 知识访问范围 ─────────────────────────────────────────────────────
    const knowledgeAccess = coreOnly
      ? {
          personal: { scopeType: 'project' as const, scopeId: projectId, label: '当前群聊个人知识' },
          project: null,
          enterprise: { scopeType: 'shared' as const, scopeId: 'shared-knowledge', label: '企业知识' },
        }
      : this.buildKnowledgeAccess(projectId);

    // ── 当前智能体信息 ───────────────────────────────────────────────────
    const agent = this.buildAgentInfo(agentInstanceId);

    const skills = coreOnly ? [] : new SkillRegistry(this.db).resolveForDefinition(agent.definitionId, agent.definitionVersion)
      .map(({ id, version, name, description, requiredTools }) => ({ id, version, name, description, requiredTools }));
    const workflows = coreOnly ? [] : new WorkflowRegistry(this.db).listForDefinition(agent.definitionId, agent.definitionVersion)
      .map(({ id, version, name, description }) => ({ id, version, name, description }));

    // ── 群聊成员 ─────────────────────────────────────────────────────────
    const members = coreOnly ? [] : this.buildMembers(projectId);

    // ── 最近消息 + 滚动摘要 ──────────────────────────────────────────────
    const { messages, rollingSummary } = this.buildMessages(projectId, triggerMessageId);

    // ── 记忆（纯查询；访问回写统一在快照构建完成后执行）─────────────────
    const recallQuery = messages.find((message) => message.id === triggerMessageId)?.content
      ?? [...messages].reverse().find((message) => message.senderType === 'user')?.content
      ?? '';
    const { memory, touchedMemoryIds } = this.buildMemory(projectId, agentInstanceId, agent.role, recallQuery);

    // ── 引用文件 ─────────────────────────────────────────────────────────
    const referencedFiles = coreOnly ? [] : this.buildReferencedFiles(projectId, messages);

    // ── 父 Run 结果 ──────────────────────────────────────────────────────
    const parentRunResult = !coreOnly && parentRunId ? this.buildParentRunResult(parentRunId) : null;

    // ── 知识片段（按当前任务召回词检索，命中为空时降级为最新片段）────────
    const knowledgeChunks = coreOnly ? [] : this.buildKnowledgeChunks(projectId, recallQuery);

    // ── 工作区规则 ───────────────────────────────────────────────────────
    const workspace = this.buildWorkspaceInfo(projectId);

    const snapshot: ContextSnapshot = {
      builtAt: new Date().toISOString(),
      project: projectInfo,
      knowledgeAccess,
      agent,
      skills,
      workflows,
      members,
      messages,
      rollingSummary,
      memory,
      referencedFiles,
      parentRunResult,
      knowledgeChunks,
      workspace,
      snapshotChecksum: '',
    };

    // 生成快照校验和
    snapshot.snapshotChecksum = this.calcChecksum(snapshot);

    // 记忆访问回写：与查询分离的单次写操作，保持 buildMemory 可重放。
    this.markMemoryAccessed(touchedMemoryIds);

    logger?.info({ projectId, agentInstanceId }, 'ContextBuilder: 上下文快照构建完成');
    return snapshot;
  }

  /**
   * 将 ContextSnapshot 渲染为 System Prompt 的上下文文本块
   */
  renderToText(snapshot: ContextSnapshot, options?: { includeMemory?: boolean }): string {
    const parts: string[] = [];

    // Definition 系统规则与群聊实例身份必须先于普通上下文出现。
    parts.push(this.renderAgentDirective(snapshot));

    // 群聊与知识权限。项目知识只在存在有效关联时出现。
    const knowledgeScopes = [
      snapshot.knowledgeAccess.personal.label,
      snapshot.knowledgeAccess.project?.label,
      snapshot.knowledgeAccess.enterprise.label,
    ].filter(Boolean).join(' -> ');
    parts.push([
      '## 群聊与知识范围',
      `- 群聊名称: ${snapshot.project.name}`,
      `- 群聊摘要: ${snapshot.project.summary || '(无)'}`,
      `- 关联项目: ${snapshot.knowledgeAccess.project?.name ?? '未关联项目'}`,
      `- 当前可检索范围: ${knowledgeScopes}`,
      '- 权限边界: 只可读取上述范围；不得读取其他群聊的个人知识或未关联项目的知识。',
      '- 检索约定: knowledge:search 会自动覆盖上述全部范围并标注证据所属层级，无需分别重复查询。',
    ].join('\n'));

    if (snapshot.skills.length > 0) {
      parts.push(`## 自身技能目录\n先用 skill:search 按任务筛选，确定需要后再用 skill:load 读取正文；不要加载或复述无关技能。\n${snapshot.skills.map((skill) => `- ${skill.id}@${skill.version}：${skill.description}`).join('\n')}`);
    }
    if (snapshot.workflows.length > 0) {
      parts.push(`## 可用协同工作流（需要时调用 workflow:load 读取正文）\n${snapshot.workflows.map((workflow) => `- ${workflow.id}@${workflow.version}：${workflow.description}`).join('\n')}`);
    }

    // 群聊成员
    if (snapshot.members.length > 0) {
      parts.push(`## 群聊成员\n${snapshot.members.map((m) => `- ${m.name} (${m.role})`).join('\n')}`);
    }

    // 最近消息
    if (snapshot.messages.length > 0) {
      const msgText = snapshot.messages.map((m) => `[${m.senderType}] ${m.content.slice(0, 500)}${m.replyToId ? ' (回复)' : ''}`).join('\n');
      parts.push(`## 最近消息 (${snapshot.messages.length} 条)\n${msgText}`);
    }
    if (snapshot.rollingSummary) {
      parts.push(`## 历史滚动摘要\n${snapshot.rollingSummary}`);
    }

    // 直接执行模式会按当前任务单独召回记忆，避免把同一批通用记忆重复注入。
    if (options?.includeMemory !== false) {
      if (snapshot.memory.shortTerm.length > 0) {
        parts.push(`## 短期记忆\n${snapshot.memory.shortTerm.join('\n')}`);
      }
      if (snapshot.memory.longTerm.length > 0) {
        parts.push(`## 长期知识\n${snapshot.memory.longTerm.join('\n')}`);
      }
    }

    // 引用文件
    if (snapshot.referencedFiles.length > 0) {
      parts.push(`## 引用文件\n${snapshot.referencedFiles.map((f) => `- ${f.name} (${f.path})`).join('\n')}`);
    }

    // 父 Run 结果
    if (snapshot.parentRunResult) {
      parts.push(`## 父任务结果\n${snapshot.parentRunResult.slice(0, 1000)}`);
    }

    // 知识片段
    if (snapshot.knowledgeChunks.length > 0) {
      parts.push(`## 知识库检索结果\n${snapshot.knowledgeChunks.map((k) => `[${k.sourceLabel}] ${k.text.slice(0, 300)}`).join('\n\n')}`);
    }

    // 工作区规则
    parts.push(`## 工作区规则\n- 根目录: ${snapshot.workspace.rootPath}\n- 允许的根目录: ${snapshot.workspace.allowedRoots.join(', ')}\n- 成果发布方式: ${snapshot.workspace.publishMethod}`);

    return parts.join('\n\n---\n\n');
  }

  /** 统一提供给原生模型、LangGraph 与外部 CLI 的角色指令层。 */
  renderAgentDirective(snapshot: ContextSnapshot): string {
    const parts = [
      snapshot.agent.definitionSystemPrompt
        ? `## Agent Definition 系统规则\n${snapshot.agent.definitionSystemPrompt}`
        : '',
      `## 当前群聊智能体\n- 名称: ${snapshot.agent.profileName}\n- 群聊角色: ${snapshot.agent.role}\n- 权限: ${snapshot.agent.permissions.join(', ') || '无'}`,
      snapshot.agent.identity
        ? `## 本群聊身份配置\n${snapshot.agent.identity}`
        : '## 本群聊身份配置\n请按照当前智能体名称、Definition 与群聊分工执行任务。',
    ];
    return parts.filter(Boolean).join('\n\n');
  }

  // ── 私有方法 ─────────────────────────────────────────────────────────────

  /** 身份文件内容缓存：以 mtimeMs 判失效，避免每次响应重复读盘。 */
  private static identityFileCache = new Map<string, { mtimeMs: number; text: string }>();

  private readIdentityFileSync(path: string): string {
    const fs = require('node:fs');
    const stat = fs.statSync(path);
    const cached = ContextBuilder.identityFileCache.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.text;
    const text = fs.readFileSync(path, 'utf-8');
    ContextBuilder.identityFileCache.set(path, { mtimeMs: stat.mtimeMs, text });
    return text;
  }

  private buildAgentInfo(agentInstanceId: string): ContextSnapshot['agent'] {
    const row = this.db.prepare(`
      SELECT pai.id as instanceId, pai.project_id as projectId, ap.name as profileName, pai.role,
             pai.definition_id as definitionId, pai.definition_version as definitionVersion,
             pai.identity_rel_path as identityRelPath, pai.effective_permissions_json as permissionsJson
      FROM project_agent_instances pai
      JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
      WHERE pai.id = ?
    `).get(agentInstanceId) as {
      instanceId: string; projectId: string; profileName: string; role: string;
      definitionId: string | null; definitionVersion: string | null; identityRelPath: string | null; permissionsJson: string | null;
    } | undefined;

    if (!row) {
      return { instanceId: agentInstanceId, profileName: agentInstanceId, role: 'unknown', definitionId: '', definitionVersion: '', definitionSystemPrompt: null, identity: null, permissions: [] };
    }

    let identity: string | null = null;
    if (row.identityRelPath) {
      try {
        const identityPath = isAbsolute(row.identityRelPath)
          ? row.identityRelPath
          : join(getProjectRoot(row.projectId), row.identityRelPath);
        const rolePath = join(dirname(identityPath), 'ROLE.md');
        const adaptationPath = join(dirname(identityPath), 'ADAPTATION.md');
        const identityText = this.readIdentityFileSync(identityPath);
        let roleText = '';
        let adaptationText = '';
        try { roleText = this.readIdentityFileSync(rolePath); } catch { /* legacy project without role card */ }
        try { adaptationText = this.readIdentityFileSync(adaptationPath); } catch { /* legacy project without adaptation layer */ }
        identity = [
          `### 核心身份快照\n${identityText}`,
          roleText ? `### 群聊实例约束\n${roleText}` : '',
          adaptationText ? `### 群聊适应性补充\n${adaptationText}` : '',
        ].filter(Boolean).join('\n\n').slice(0, 3_000);
      } catch {
        identity = null;
      }
    }

    const definitionSystemPrompt = loadAgentDefinitionText(
      row.definitionId ?? '',
      row.definitionVersion ?? '1.0.0',
    ).systemPrompt?.slice(0, 2_000) ?? null;

    const permissions: string[] = [];
    if (row.permissionsJson) {
      try {
        const parsed = JSON.parse(row.permissionsJson);
        if (Array.isArray(parsed)) permissions.push(...parsed);
        else if (typeof parsed === 'object') permissions.push(...Object.keys(parsed));
      } catch { /* ignore */ }
    }

    return {
      instanceId: row.instanceId,
      profileName: row.profileName,
      role: row.role,
      definitionId: row.definitionId ?? '',
      definitionVersion: row.definitionVersion ?? '1.0.0',
      definitionSystemPrompt,
      identity,
      permissions,
    };
  }

  private buildMembers(projectId: string): ContextSnapshot['members'] {
    const rows = this.db.prepare(`
      SELECT pai.id as instanceId, ap.name as name, pai.role
      FROM project_agent_instances pai
      JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
      WHERE pai.project_id = ? AND ap.enabled = 1
      ORDER BY pai.ordinal
    `).all(projectId) as Array<{ instanceId: string; name: string; role: string }>;

    return rows.map((r) => ({ instanceId: r.instanceId, name: r.name, role: r.role }));
  }

  private buildMessages(projectId: string, triggerMessageId?: string): { messages: ContextSnapshot['messages']; rollingSummary: string | null } {
    const limit = this.options.recentMessageLimit;
    const context = triggerMessageId
      ? selectTaskContext(this.db, projectId, triggerMessageId, { limit })
      : { messages: [] as TaskContextMessageRow[], overflow: [] as TaskContextMessageRow[] };

    const messages = context.messages.map((m) => {
      let content = m.contentJson;
      try { content = JSON.parse(content).text ?? content; } catch { /* use raw */ }
      return {
        id: m.id,
        senderType: m.senderType,
        senderId: m.senderId,
        content: content.slice(0, 1200),
        replyToId: m.replyToId,
        createdAt: m.createdAt,
        taskRelation: m.taskRelation,
      };
    });

    return { messages, rollingSummary: this.buildRollingSummary(context.overflow) };
  }

  /** 将被消息预算截断的任务链前情压缩为一条滚动摘要，避免静默丢失。 */
  private buildRollingSummary(overflow: TaskContextMessageRow[]): string | null {
    if (overflow.length === 0) return null;
    const shown = overflow.slice(-10);
    const hidden = overflow.length - shown.length;
    const lines = shown.map((row) => {
      let content = row.contentJson;
      try { content = JSON.parse(content).text ?? content; } catch { /* use raw */ }
      const who = row.senderType === 'user' ? '用户' : row.senderId;
      return `- ${who}: ${content.slice(0, 200).replace(/\s+/g, ' ').trim()}`;
    });
    const headline = `以下是本次任务链中更早的 ${overflow.length} 条消息${hidden > 0 ? `（仅展示最近 10 条，另有 ${hidden} 条省略）` : ''}：`;
    return [headline, ...lines].join('\n');
  }

  private buildMemory(projectId: string, agentInstanceId: string, _role: string, query: string): { memory: ContextSnapshot['memory']; touchedMemoryIds: string[] } {
    const memoryColumns = `
      SELECT mr.id, mr.project_id as projectId, mr.agent_instance_id as agentInstanceId,
             mr.scope, mr.type, mr.content, mr.confidence, mr.importance, mr.pinned,
             mr.topic_key as topicKey, mr.source_refs_json as sourceRefsJson,
             mr.metadata_json as metadataJson, mr.status, mr.expires_at as expiresAt,
             mr.last_reinforced_at as lastReinforcedAt, mr.last_accessed_at as lastAccessedAt,
             mr.access_count as accessCount, mr.consolidated_into_id as consolidatedIntoId,
             mr.supersedes_id as supersedesId, mr.created_at as createdAt, mr.updated_at as updatedAt
      FROM memory_records mr`;
    const rows = this.db.prepare(`
      ${memoryColumns}
      WHERE mr.project_id = ? AND mr.status = 'active'
        AND mr.agent_instance_id = ?
      ORDER BY mr.last_reinforced_at DESC
      LIMIT 40
    `).all(projectId, agentInstanceId) as MemoryRecord[];

    const ranked = rankMemories(query, rows, {
      limit: 8,
      minimumScore: query.trim() ? 0.42 : 0.52,
      shortTermHalfLifeHours: 72,
      longTermHalfLifeHours: 30 * 24,
    });
    const touchedMemoryIds = ranked.map(({ record }) => record.id);

    const shortTerm = ranked.filter(({ record }) => record.scope === 'short-term').slice(0, 3);
    const longTerm = ranked.filter(({ record }) => record.scope === 'long-term').slice(0, 3);

    // 群聊级共享记忆：其他成员沉淀的固定规则/项目约束（pinned 长期记忆）对
    // 当前智能体可见。避免统筹记录的群聊约束与交付偏好（如"报告一律先出
    // Markdown 定稿"）对被委派成员完全不可见，导致协作行为割裂。
    const sharedRows = this.db.prepare(`
      ${memoryColumns}
      WHERE mr.project_id = ? AND mr.status = 'active'
        AND mr.agent_instance_id != ?
        AND mr.scope = 'long-term'
        AND (mr.pinned = 1 OR mr.type = 'project-constraint')
      ORDER BY mr.last_reinforced_at DESC
      LIMIT 20
    `).all(projectId, agentInstanceId) as MemoryRecord[];
    const sharedRanked = rankMemories(query, sharedRows, {
      limit: 2,
      minimumScore: query.trim() ? 0.42 : 0.52,
      shortTermHalfLifeHours: 72,
      longTermHalfLifeHours: 30 * 24,
    }).filter(({ record }) => record.scope === 'long-term');
    const sharedMemory = sharedRanked.map(({ record }) => `[团队共享·${record.pinned ? '固定规则' : record.topicKey ?? record.type}] ${record.content.slice(0, 400)}`);
    touchedMemoryIds.push(...sharedRanked.map(({ record }) => record.id));

    return {
      memory: {
        shortTerm: shortTerm.map(({ record }) => `[${record.topicKey ?? record.type}] ${record.content.slice(0, 400)}`),
        longTerm: [...longTerm.map(({ record }) => `[${record.pinned ? '固定规则' : record.topicKey ?? record.type}] ${record.content.slice(0, 550)}`), ...sharedMemory],
      },
      touchedMemoryIds,
    };
  }

  /** 记忆访问回写（唯一的写操作，与 buildMemory 查询分离）。 */
  private markMemoryAccessed(memoryIds: string[]): void {
    if (memoryIds.length === 0) return;
    const placeholders = memoryIds.map(() => '?').join(',');
    this.db.prepare(
      `UPDATE memory_records SET last_accessed_at = ?, access_count = access_count + 1 WHERE id IN (${placeholders})`,
    ).run(new Date().toISOString(), ...memoryIds);
  }

  private buildReferencedFiles(projectId: string, messages: ContextSnapshot['messages']): ContextSnapshot['referencedFiles'] {
    // 从消息附件中查找引用文件
    const messageIds = messages.map((m) => m.id);
    if (messageIds.length === 0) return [];

    const placeholders = messageIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT ma.file_id as fileId, f.name, f.normalized_path as path
      FROM message_attachments ma
      JOIN files f ON f.id = ma.file_id
      WHERE ma.message_id IN (${placeholders}) AND f.status = 'ready'
    `).all(...messageIds) as Array<{ fileId: string; name: string; path: string }>;

    return rows;
  }

  private buildParentRunResult(parentRunId: string): string | null {
    try {
      const parentRun = this.runRepo.getById(parentRunId);
      if (parentRun.status !== 'completed' || !parentRun.resultMessageId) return null;

      const msgRow = this.db.prepare(
        'SELECT content_json as contentJson FROM messages WHERE id = ?',
      ).get(parentRun.resultMessageId) as { contentJson: string } | undefined;

      if (!msgRow) return null;
      let content = msgRow.contentJson;
      try { content = JSON.parse(content).text ?? content; } catch { /* use raw */ }
      return content.slice(0, 2000);
    } catch {
      return null;
    }
  }

  private buildKnowledgeAccess(groupId: string): ContextSnapshot['knowledgeAccess'] {
    const scopes = resolveKnowledgeScopesForGroup(this.db, groupId);
    const projectScope = scopes.find((scope) => scope.workspaceType === 'enterprise-project');
    const linkedProject = projectScope ? getEnterpriseProject(this.db, projectScope.scopeId) : null;
    return {
      personal: { scopeType: 'project', scopeId: groupId, label: '当前群聊个人知识' },
      project: projectScope
        ? {
            scopeType: 'project',
            scopeId: projectScope.scopeId,
            label: `关联项目知识（${linkedProject?.name ?? projectScope.scopeId}）`,
            name: linkedProject?.name ?? projectScope.scopeId,
          }
        : null,
      enterprise: { scopeType: 'shared', scopeId: 'shared-knowledge', label: '企业知识' },
    };
  }

  private buildKnowledgeChunks(projectId: string, recallQuery: string): ContextSnapshot['knowledgeChunks'] {
    const access = this.buildKnowledgeAccess(projectId);
    const scopes = [
      { ...access.personal, quota: access.project ? 3 : this.options.knowledgeChunkLimit },
      ...(access.project ? [{ ...access.project, quota: 2 }] : []),
      { ...access.enterprise, quota: this.options.sharedKnowledgeChunkLimit },
    ];
    const maxChunks = this.options.knowledgeChunkLimit + this.options.sharedKnowledgeChunkLimit;
    const keywords = this.extractRecallKeywords(recallQuery);
    const selected: ContextSnapshot['knowledgeChunks'] = [];
    const overflow: ContextSnapshot['knowledgeChunks'] = [];

    for (const scope of scopes) {
      const rows = keywords.length > 0
        ? this.searchKnowledgeChunksByKeywords(scope, keywords, maxChunks)
        : [];
      // 无相关命中时降级为最新片段，保证知识注入不因检索空转而完全消失。
      const effective = rows.length > 0 ? rows : this.latestKnowledgeChunks(scope, maxChunks);
      const mapped = effective.map((row) => ({
        sourceId: row.id,
        text: row.text.slice(0, 500),
        sourceLabel: scope.label,
      }));
      selected.push(...mapped.slice(0, scope.quota));
      overflow.push(...mapped.slice(scope.quota));
    }

    return [...selected, ...overflow].slice(0, maxChunks);
  }

  /** 按标点与空白切分召回语句，提取可用于 LIKE 匹配的关键词。 */
  private extractRecallKeywords(query: string): string[] {
    const segments = query
      .replace(/[，。！？；：、,.!?;:()\[\]{}（）【】“”‘’"'`\n\r\t]+/g, ' ')
      .split(' ')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length >= 2 && segment.length <= 12 && !/[%_]/.test(segment));
    return [...new Set(segments)].slice(0, 6);
  }

  /** 依据任务召回词检索知识片段，按命中关键词数与创建时间排序。 */
  private searchKnowledgeChunksByKeywords(
    scope: { scopeType: string; scopeId: string },
    keywords: string[],
    limit: number,
  ): Array<{ id: string; text: string }> {
    const likePatterns = keywords.map((keyword) => `%${keyword}%`);
    const likeClause = likePatterns.map(() => 'c.text LIKE ?').join(' OR ');
    const rows = this.db.prepare(`
      SELECT c.id, c.text, c.created_at as createdAt
      FROM knowledge_chunks c
      JOIN knowledge_sources ks ON ks.id = c.source_id
      WHERE ks.scope_type = ? AND ks.scope_id = ? AND ks.status = 'ready'
        AND (${likeClause})
      ORDER BY c.created_at DESC
      LIMIT ?
    `).all(scope.scopeType, scope.scopeId, ...likePatterns, limit * 3) as Array<{ id: string; text: string; createdAt: string }>;
    const keywordHits = (text: string) => keywords.reduce((count, keyword) => count + (text.includes(keyword) ? 1 : 0), 0);
    return rows
      .map((row) => ({ row, hits: keywordHits(row.text) }))
      .sort((a, b) => b.hits - a.hits || (a.row.createdAt < b.row.createdAt ? 1 : -1))
      .slice(0, limit)
      .map(({ row }) => ({ id: row.id, text: row.text }));
  }

  /** 降级路径：无召回词命中时按创建时间取最新片段。 */
  private latestKnowledgeChunks(scope: { scopeType: string; scopeId: string }, limit: number): Array<{ id: string; text: string }> {
    return this.db.prepare(`
      SELECT c.id, c.text
      FROM knowledge_chunks c
      JOIN knowledge_sources ks ON ks.id = c.source_id
      WHERE ks.scope_type = ? AND ks.scope_id = ? AND ks.status = 'ready'
      ORDER BY c.created_at DESC
      LIMIT ?
    `).all(scope.scopeType, scope.scopeId, limit) as Array<{ id: string; text: string }>;
  }

  private buildWorkspaceInfo(projectId: string): ContextSnapshot['workspace'] {
    // 与 agent-tools.ts 的 resolveWorkspaceReadPath 保持同一份白名单，避免误导模型访问被拒路径。
    return {
      rootPath: getProjectRoot(projectId),
      allowedRoots: ['original-files/', 'outputs/', 'wiki/', 'knowledge/', 'temp/', 'agent-memories/', 'agent-identities/'],
      publishMethod: '中间产物使用 temp:save，正式成果由统筹使用 temp:promote',
    };
  }

  private calcChecksum(snapshot: ContextSnapshot): string {
    const { snapshotChecksum: _, ...rest } = snapshot;
    // sha256 截取 16 位十六进制（64bit），替代原 32 位字符串 hash 的碰撞风险。
    return createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16);
  }

  /**
   * 从 ContextSnapshot 构建上下文清单（context-manifest.json）。
   * 每项包含来源 ID 与 checksum。
   */
  buildManifest(snapshot: ContextSnapshot): ContextManifest {
    const entries: ManifestEntry[] = [];

    // 消息条目
    for (const msg of snapshot.messages) {
      entries.push({
        sourceId: msg.id,
        checksum: this.calcEntryChecksum(msg.content),
        category: 'message',
        summary: msg.content.slice(0, 200),
      });
    }

    // 引用文件（附件）条目
    for (const file of snapshot.referencedFiles) {
      entries.push({
        sourceId: file.fileId,
        checksum: this.calcEntryChecksum(file.path),
        category: 'attachment',
        summary: file.name,
      });
    }

    // 知识片段条目
    for (const chunk of snapshot.knowledgeChunks) {
      entries.push({
        sourceId: chunk.sourceId,
        checksum: this.calcEntryChecksum(chunk.text),
        category: 'knowledge',
        summary: chunk.text.slice(0, 200),
      });
    }

    // 身份摘要条目
    if (snapshot.agent.identity) {
      entries.push({
        sourceId: snapshot.agent.instanceId,
        checksum: this.calcEntryChecksum(snapshot.agent.identity),
        category: 'identity',
        summary: `智能体身份: ${snapshot.agent.profileName}`,
      });
    }

    // 记忆条目
    for (const m of snapshot.memory.shortTerm) {
      entries.push({
        sourceId: 'short-term',
        checksum: this.calcEntryChecksum(m),
        category: 'memory',
        summary: m.slice(0, 200),
      });
    }
    for (const m of snapshot.memory.longTerm) {
      entries.push({
        sourceId: 'long-term',
        checksum: this.calcEntryChecksum(m),
        category: 'memory',
        summary: m.slice(0, 200),
      });
    }

    // 父任务结果条目
    if (snapshot.parentRunResult) {
      entries.push({
        sourceId: 'parent-run',
        checksum: this.calcEntryChecksum(snapshot.parentRunResult),
        category: 'parent_run',
        summary: snapshot.parentRunResult.slice(0, 200),
      });
    }

    return {
      manifestVersion: 1,
      builtAt: snapshot.builtAt,
      snapshotChecksum: snapshot.snapshotChecksum,
      entries,
    };
  }

  /**
   * 将 context-manifest.json 写入指定目录。
   * 目录不存在时自动创建。
   */
  async writeContextManifest(snapshot: ContextSnapshot, targetDir: string): Promise<ContextManifest> {
    const logger = getLogger();
    const manifest = this.buildManifest(snapshot);
    const manifestPath = join(targetDir, 'context-manifest.json');

    try {
      await mkdir(targetDir, { recursive: true });
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
      logger?.info({ targetDir, entryCount: manifest.entries.length }, 'ContextBuilder: context-manifest.json 已写入');
    } catch (err) {
      logger?.warn({ err, targetDir }, 'ContextBuilder: 写入 context-manifest.json 失败');
      throw err;
    }

    return manifest;
  }

  private calcEntryChecksum(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }
}
