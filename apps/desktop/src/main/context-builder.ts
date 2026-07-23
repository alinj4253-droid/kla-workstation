import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type Database from 'better-sqlite3';
import { ProjectRepository, SearchRepository, AgentRunRepository, FileRepository, MemoryRepository } from '@kunqing/database';
import type { ProjectRow } from '@kunqing/database';
import { getLogger } from './logger';

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

  // ── 当前智能体信息 ─────────────────────────────────────────────────────────
  agent: {
    instanceId: string;
    profileName: string;
    role: string;
    definitionId: string;
    identity: string | null;
    permissions: string[];
  };

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
  /** 最多包含的最近消息数（默认 30） */
  recentMessageLimit?: number;
  /** 知识片段最大数量（默认 10） */
  knowledgeChunkLimit?: number;
  /** 共享知识片段最大数量（默认 5） */
  sharedKnowledgeChunkLimit?: number;
};

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
  private memoryRepo: MemoryRepository;
  private options: Required<ContextBuilderOptions>;

  constructor(db: Database.Database, options?: ContextBuilderOptions) {
    this.db = db;
    this.projectRepo = new ProjectRepository(db);
    this.searchRepo = new SearchRepository(db);
    this.runRepo = new AgentRunRepository(db);
    this.fileRepo = new FileRepository(db);
    this.memoryRepo = new MemoryRepository(db);
    this.options = {
      recentMessageLimit: options?.recentMessageLimit ?? 30,
      knowledgeChunkLimit: options?.knowledgeChunkLimit ?? 10,
      sharedKnowledgeChunkLimit: options?.sharedKnowledgeChunkLimit ?? 5,
    };
  }

  /**
   * 为指定 Run 构建不可变 ContextSnapshot
   */
  build(projectId: string, agentInstanceId: string, triggerMessageId?: string, parentRunId?: string): ContextSnapshot {
    const logger = getLogger();
    logger?.info({ projectId, agentInstanceId }, 'ContextBuilder: 开始构建上下文快照');

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
      sharedKnowledgeEnabled: project.sharedKnowledgeEnabled,
    };

    // ── 当前智能体信息 ───────────────────────────────────────────────────
    const agent = this.buildAgentInfo(agentInstanceId);

    // ── 群聊成员 ─────────────────────────────────────────────────────────
    const members = this.buildMembers(projectId);

    // ── 最近消息 + 滚动摘要 ──────────────────────────────────────────────
    const { messages, rollingSummary } = this.buildMessages(projectId, triggerMessageId);

    // ── 记忆 ─────────────────────────────────────────────────────────────
    const memory = this.buildMemory(projectId, agentInstanceId);

    // ── 引用文件 ─────────────────────────────────────────────────────────
    const referencedFiles = this.buildReferencedFiles(projectId, messages);

    // ── 父 Run 结果 ──────────────────────────────────────────────────────
    const parentRunResult = parentRunId ? this.buildParentRunResult(parentRunId) : null;

    // ── 知识片段 ─────────────────────────────────────────────────────────
    const knowledgeChunks = this.buildKnowledgeChunks(projectId, project.sharedKnowledgeEnabled);

    // ── 工作区规则 ───────────────────────────────────────────────────────
    const workspace = this.buildWorkspaceInfo(projectId);

    const snapshot: ContextSnapshot = {
      builtAt: new Date().toISOString(),
      project: projectInfo,
      agent,
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

    logger?.info({ projectId, agentInstanceId }, 'ContextBuilder: 上下文快照构建完成');
    return snapshot;
  }

  /**
   * 将 ContextSnapshot 渲染为 System Prompt 的上下文文本块
   */
  renderToText(snapshot: ContextSnapshot): string {
    const parts: string[] = [];

    // 项目信息
    parts.push(`## 项目信息\n- 项目名称: ${snapshot.project.name}\n- 项目摘要: ${snapshot.project.summary || '(无)'}\n- 共享知识: ${snapshot.project.sharedKnowledgeEnabled ? '已开启' : '已关闭'}`);

    // 智能体信息
    parts.push(`## 当前智能体\n- 名称: ${snapshot.agent.profileName}\n- 角色: ${snapshot.agent.role}\n- 身份: ${snapshot.agent.identity || '(无)'}\n- 权限: ${snapshot.agent.permissions.join(', ') || '无'}`);

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

    // 记忆
    if (snapshot.memory.shortTerm.length > 0) {
      parts.push(`## 短期记忆\n${snapshot.memory.shortTerm.join('\n')}`);
    }
    if (snapshot.memory.longTerm.length > 0) {
      parts.push(`## 长期知识\n${snapshot.memory.longTerm.join('\n')}`);
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

  // ── 私有方法 ─────────────────────────────────────────────────────────────

  private buildAgentInfo(agentInstanceId: string): ContextSnapshot['agent'] {
    const row = this.db.prepare(`
      SELECT pai.id as instanceId, ap.name as profileName, pai.role, pai.definition_id as definitionId,
             pai.identity_rel_path as identityRelPath, pai.effective_permissions_json as permissionsJson
      FROM project_agent_instances pai
      JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
      WHERE pai.id = ?
    `).get(agentInstanceId) as {
      instanceId: string; profileName: string; role: string;
      definitionId: string | null; identityRelPath: string | null; permissionsJson: string | null;
    } | undefined;

    if (!row) {
      return { instanceId: agentInstanceId, profileName: agentInstanceId, role: 'unknown', definitionId: '', identity: null, permissions: [] };
    }

    let identity: string | null = null;
    if (row.identityRelPath) {
      try {
        const fs = require('node:fs');
        identity = fs.readFileSync(row.identityRelPath, 'utf-8').slice(0, 2000);
      } catch {
        identity = null;
      }
    }

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
      identity,
      permissions,
    };
  }

  private buildMembers(projectId: string): ContextSnapshot['members'] {
    const rows = this.db.prepare(`
      SELECT pai.id as instanceId, ap.name as name, pai.role
      FROM project_agent_instances pai
      JOIN agent_profiles ap ON ap.id = pai.agent_profile_id
      WHERE pai.project_id = ?
      ORDER BY pai.ordinal
    `).all(projectId) as Array<{ instanceId: string; name: string; role: string }>;

    return rows.map((r) => ({ instanceId: r.instanceId, name: r.name, role: r.role }));
  }

  private buildMessages(projectId: string, triggerMessageId?: string): { messages: ContextSnapshot['messages']; rollingSummary: string | null } {
    const limit = this.options.recentMessageLimit;

    const rows = this.db.prepare(`
      SELECT id, sender_type as senderType, sender_id as senderId, content_json as contentJson, reply_to_id as replyToId, created_at as createdAt
      FROM messages
      WHERE project_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(projectId, limit + 10) as Array<{
      id: string; senderType: string; senderId: string;
      contentJson: string; replyToId: string | null; createdAt: string;
    }>;

    // 如果有 triggerMessageId，确保它在消息列表中
    let allMessages = rows.reverse();
    if (triggerMessageId && !allMessages.some((m) => m.id === triggerMessageId)) {
      const trigger = this.db.prepare(`
        SELECT id, sender_type as senderType, sender_id as senderId, content_json as contentJson, reply_to_id as replyToId, created_at as createdAt
        FROM messages WHERE id = ?
      `).get(triggerMessageId) as typeof rows[0] | undefined;
      if (trigger) allMessages.push(trigger);
    }

    // 如果超过预算，截断并生成滚动摘要
    let rollingSummary: string | null = null;
    if (allMessages.length > limit) {
      const olderMessages = allMessages.slice(0, allMessages.length - limit);
      allMessages = allMessages.slice(allMessages.length - limit);

      const olderText = olderMessages
        .map((m) => {
          let content = m.contentJson;
          try { content = JSON.parse(content).text ?? content; } catch { /* use raw */ }
          return `[${m.senderType}] ${content.slice(0, 200)}`;
        })
        .join('\n');
      rollingSummary = `以下为更早消息的摘要（共 ${olderMessages.length} 条）：\n${olderText.slice(0, 2000)}`;
    }

    const messages = allMessages.map((m) => {
      let content = m.contentJson;
      try { content = JSON.parse(content).text ?? content; } catch { /* use raw */ }
      return {
        id: m.id,
        senderType: m.senderType,
        senderId: m.senderId,
        content: content.slice(0, 2000),
        replyToId: m.replyToId,
        createdAt: m.createdAt,
      };
    });

    return { messages, rollingSummary };
  }

  private buildMemory(projectId: string, agentInstanceId: string): ContextSnapshot['memory'] {
    const shortTerm = this.memoryRepo.list(projectId, agentInstanceId, 'short-term', 'active');
    const longTerm = this.memoryRepo.list(projectId, agentInstanceId, 'long-term', 'active');

    // 过滤过期短期记忆
    const now = new Date().toISOString();
    const validShort = shortTerm.filter((m) => !m.expiresAt || m.expiresAt > now);

    return {
      shortTerm: validShort.slice(0, 5).map((m) => `[${m.type}] ${m.content.slice(0, 300)}`),
      longTerm: longTerm.slice(0, 3).map((m) => `[${m.type}] ${m.content.slice(0, 500)}`),
    };
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

  private buildKnowledgeChunks(projectId: string, sharedKnowledgeEnabled: boolean): ContextSnapshot['knowledgeChunks'] {
    const chunks: ContextSnapshot['knowledgeChunks'] = [];
    const projectChunks = this.db.prepare(`
      SELECT c.id, c.text, ks.scope_type as scopeType, ks.scope_id as scopeId
      FROM knowledge_chunks c
      JOIN knowledge_sources ks ON ks.id = c.source_id
      WHERE ks.scope_type = 'project' AND ks.scope_id = ? AND ks.status = 'ready'
      ORDER BY c.created_at DESC
      LIMIT ?
    `).all(projectId, this.options.knowledgeChunkLimit) as Array<{
      id: string; text: string; scopeType: string; scopeId: string;
    }>;

    for (const c of projectChunks) {
      chunks.push({ sourceId: c.id, text: c.text.slice(0, 500), sourceLabel: '群聊知识' });
    }

    // 共享知识
    if (sharedKnowledgeEnabled && chunks.length < this.options.knowledgeChunkLimit + this.options.sharedKnowledgeChunkLimit) {
      const sharedLimit = Math.min(this.options.sharedKnowledgeChunkLimit, this.options.knowledgeChunkLimit + this.options.sharedKnowledgeChunkLimit - chunks.length);
      const shared = this.db.prepare(`
        SELECT c.id, c.text
        FROM knowledge_chunks c
        JOIN knowledge_sources ks ON ks.id = c.source_id
        WHERE ks.scope_type = 'shared' AND ks.status = 'ready'
        ORDER BY c.created_at DESC
        LIMIT ?
      `).all(sharedLimit) as Array<{ id: string; text: string }>;

      for (const c of shared) {
        chunks.push({ sourceId: c.id, text: c.text.slice(0, 500), sourceLabel: '共享知识' });
      }
    }

    return chunks;
  }

  private buildWorkspaceInfo(_projectId: string): ContextSnapshot['workspace'] {
    // 从 workspace_registry 获取工作区信息
    const row = this.db.prepare(`
      SELECT root_path_hash as rootPathHash FROM workspace_registry LIMIT 1
    `).get() as { rootPathHash: string } | undefined;

    return {
      rootPath: row?.rootPathHash ?? '(未配置)',
      allowedRoots: ['workspace', 'artifacts'],
      publishMethod: 'publish_artifact 工具',
    };
  }

  private calcChecksum(snapshot: ContextSnapshot): string {
    const { snapshotChecksum: _, ...rest } = snapshot;
    let hash = 0;
    const str = JSON.stringify(rest);
    for (let i = 0; i < str.length; i++) {
      const chr = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
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
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const chr = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }
}