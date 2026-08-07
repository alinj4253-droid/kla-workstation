import type Database from 'better-sqlite3';
import { safeStorage } from 'electron';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type pino from 'pino';
import type {
  ChannelAdapter,
  ChannelType,
  ChannelTestResult,
  ChannelHealth,
  ChannelStatus,
  InboundChannelEvent,
  OutboundChannelMessage,
  ResolvedChannelConfig,
  DeliveryReceipt,
  RemoteAttachment,
} from '@kunqing/channel-core';
import { TelegramAdapter, LarkAdapter, DingTalkAdapter, WeComWebhookAdapter } from '@kunqing/channel-core';
import { FileRepository, MessageRepository } from '@kunqing/database';
import { getProjectRoot } from './paths';
import { getLogger } from './logger';
import { createProject } from './project-creator';

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MB

/** Maximum message length per channel type (Telegram: 4096, others: larger) */
const CHANNEL_MAX_MESSAGE_LENGTH: Record<string, number> = {
  telegram: 4096,
  lark: 16384,
  dingtalk: 16384,
  'wecom-webhook': 4096,
};
const CHANNEL_TYPE_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  lark: '飞书 / Lark',
  dingtalk: '钉钉',
  'wecom-webhook': '企业微信群机器人',
};
const ALLOWED_MIME_PREFIXES = [
  'image/', 'video/', 'audio/',
  'application/pdf', 'application/zip', 'application/x-rar',
  'text/plain', 'text/csv', 'text/markdown', 'text/html',
  'application/json', 'application/xml', 'application/vnd.openxmlformats-officedocument',
  'application/vnd.ms-',
  'application/msword',
];

type ChannelRow = {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  status: string;
  config_json: string | null;
  secret_ref: string | null;
  last_connected_at: string | null;
  last_error: string | null;
};

type ChannelBindingRow = {
  channel_id: string;
  external_conversation_id: string;
  project_id: string;
};

type ChannelEventRow = {
  channel_id: string;
  external_event_id: string;
  direction: string;
  status: string;
};

type EventCallback = (event: { type: string; channelId: string; data: unknown }) => void;

export class ChannelManager {
  private readonly db: Database.Database;
  private readonly logger: pino.Logger;
  private readonly adapters: Map<string, ChannelAdapter> = new Map();
  private readonly activeChannels: Map<string, {
    adapter: ChannelAdapter;
    channelId: string;
    startedAt: number;
  }> = new Map();
  private readonly dedupCache: Map<string, number> = new Map();
  private readonly retryCounts: Map<string, number> = new Map();
  private readonly retryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly rateLimitMap: Map<string, number[]> = new Map(); // channelId -> timestamps of recent sends
  /** Processing status tracking: key = `${channelId}:${conversationId}` */
  private readonly processingTimers: Map<string, boolean> = new Map();
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private eventCallback: EventCallback | null = null;

  constructor(db: Database.Database) {
    this.db = db;
    this.logger = getLogger();
    this._registerAdapters();
  }

  onEvent(callback: EventCallback): void {
    this.eventCallback = callback;
  }

  private _registerAdapters(): void {
    const instances: ChannelAdapter[] = [
      new TelegramAdapter(),
      new LarkAdapter(),
      new DingTalkAdapter(),
      new WeComWebhookAdapter(),
    ];
    for (const adapter of instances) {
      this.adapters.set(adapter.type, adapter);
    }
  }

  getAdapter(type: string): ChannelAdapter | undefined {
    return this.adapters.get(type);
  }

  getChannelStatus(channelId: string): { adapter: ChannelAdapter | null; started: boolean } {
    const active = this.activeChannels.get(channelId);
    if (active) return { adapter: active.adapter, started: true };
    const row = this.db.prepare('SELECT type FROM channels WHERE id = ?').get(channelId) as { type: string } | undefined;
    if (!row) return { adapter: null, started: false };
    return { adapter: this.adapters.get(row.type) ?? null, started: false };
  }

  async test(channelId: string): Promise<ChannelTestResult> {
    const row = this.db.prepare('SELECT id, type, config_json, secret_ref FROM channels WHERE id = ?').get(channelId) as ChannelRow | undefined;
    if (!row) return { success: false, message: '渠道不存在' };
    const adapter = this.adapters.get(row.type);
    if (!adapter) return { success: false, message: `不支持的渠道类型: ${row.type}` };
    const config = this._resolveConfig(row);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const result = await adapter.test(config, controller.signal);
      const testResult = result.success ? 'success' : 'failure';
      const now = new Date().toISOString();
      this.db.prepare('UPDATE channels SET last_test_result = ?, last_tested_at = ? WHERE id = ?').run(testResult, now, channelId);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  async start(channelId: string): Promise<void> {
    if (this.activeChannels.has(channelId)) return; // already started
    const row = this.db.prepare('SELECT id, type, config_json, secret_ref, enabled, status FROM channels WHERE id = ?').get(channelId) as ChannelRow | undefined;
    if (!row) throw new Error('渠道不存在');
    if (!row.enabled) throw new Error('渠道未启用');
    const adapter = this.adapters.get(row.type);
    if (!adapter) throw new Error(`不支持的渠道类型: ${row.type}`);
    const config = this._resolveConfig(row);
    this.db.prepare('UPDATE channels SET status = ?, updated_at = ? WHERE id = ?').run('connecting', new Date().toISOString(), channelId);
    this.logger.info({ channelId }, 'ChannelManager.start: calling adapter.start()');
    try {
      await adapter.start(config, {
        onEvent: (event) => this._handleInbound(channelId, event),
        onError: (error) => this._handleError(channelId, error),
        onStatusChange: (status) => this._updateStatus(channelId, status),
      });
      this.logger.info({ channelId }, 'ChannelManager.start: adapter.start() resolved OK');
      this.activeChannels.set(channelId, { adapter, channelId, startedAt: Date.now() });
      this._resetRetry(channelId);
      const now = new Date().toISOString();
      this.db.prepare('UPDATE channels SET status = ?, last_connected_at = ?, updated_at = ? WHERE id = ?').run('connected', now, now, channelId);
      this.logger.info({ channelId }, 'ChannelManager.start: DB updated, emitting event');
      this._emitEvent({ type: 'channel.status', channelId, data: { status: 'connected' } });
      this.logger.info({ channelId }, 'ChannelManager.start: event emitted');
    } catch (err) {
      this.logger.error({ err, channelId }, 'ChannelManager.start: CAUGHT ERROR');
      this.db.prepare('UPDATE channels SET status = ?, last_error = ?, updated_at = ? WHERE id = ?').run('error', String(err), new Date().toISOString(), channelId);
      this._emitEvent({ type: 'channel.status', channelId, data: { status: 'error', error: String(err) } });
      throw err;
    }
  }

  async stop(channelId: string): Promise<void> {
    const active = this.activeChannels.get(channelId);
    if (active) {
      await active.adapter.stop();
      this.activeChannels.delete(channelId);
    }
    this.db.prepare('UPDATE channels SET status = ?, updated_at = ? WHERE id = ?').run('disconnected', new Date().toISOString(), channelId);
    this._emitEvent({ type: 'channel.status', channelId, data: { status: 'disconnected' } });
  }

  /** Check rate limit: max 1 message per second per channel */
  private _checkRateLimit(channelId: string): boolean {
    const now = Date.now();
    const window = 1000; // 1 second
    let timestamps = this.rateLimitMap.get(channelId) ?? [];
    // Remove old entries outside the window
    timestamps = timestamps.filter((t) => now - t < window);
    if (timestamps.length >= 1) {
      return false; // Rate limited
    }
    timestamps.push(now);
    this.rateLimitMap.set(channelId, timestamps);
    return true;
  }

  async send(channelId: string, target: { conversationId: string; userId?: string }, message: { text: string }, idempotencyKey?: string): Promise<DeliveryReceipt> {
    // Stop processing status updates before sending a reply
    this._stopProcessingStatus(channelId, target.conversationId);

    // Check idempotency
    if (idempotencyKey) {
      const existing = this.db.prepare(
        'SELECT result_json FROM idempotency_requests WHERE key = ? AND operation = ?',
      ).get(idempotencyKey, `channel:send:${channelId}`) as { result_json: string } | undefined;
      if (existing) {
        return JSON.parse(existing.result_json) as DeliveryReceipt;
      }
    }

    // Rate limit check
    if (!this._checkRateLimit(channelId)) {
      return { ok: false, externalEventId: null, error: '发送频率过高，请稍后重试', sentAt: new Date().toISOString() };
    }

    const doSend = async (): Promise<DeliveryReceipt> => {
      const active = this.activeChannels.get(channelId);
      if (active) {
        return active.adapter.send(target, { conversationId: target.conversationId, text: message.text });
      }
      // Try sending via adapter without starting a full connection (e.g. webhook)
      const row = this.db.prepare('SELECT type, config_json, secret_ref FROM channels WHERE id = ?').get(channelId) as ChannelRow | undefined;
      if (!row) return { ok: false, externalEventId: null, error: '渠道不存在', sentAt: new Date().toISOString() };
      const adapter = this.adapters.get(row.type);
      if (!adapter) return { ok: false, externalEventId: null, error: '不支持的渠道类型', sentAt: new Date().toISOString() };
      const config = this._resolveConfig(row);
      const sink = { onEvent: () => {}, onError: () => {}, onStatusChange: () => {} };
      await adapter.start(config, sink);
      try {
        return await adapter.send(target, { conversationId: target.conversationId, text: message.text });
      } finally {
        await adapter.stop();
      }
    };

    // Retry with backoff (max 3 attempts)
    let lastError: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await doSend();
        // Store idempotency result
        if (idempotencyKey && result.ok) {
          const now = new Date().toISOString();
          const expiresAt = new Date(Date.now() + 86400000).toISOString(); // 24 hours
          this.db.prepare(
            'INSERT OR REPLACE INTO idempotency_requests (key, operation, request_hash, result_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(idempotencyKey, `channel:send:${channelId}`, '', JSON.stringify(result), expiresAt, now);
        }
        return result;
      } catch (err) {
        lastError = String(err);
        if (attempt < 2) {
          // Wait before retry with backoff
          await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        }
      }
    }
    return { ok: false, externalEventId: null, error: lastError ?? '发送失败', sentAt: new Date().toISOString() };
  }

  health(channelId: string): ChannelHealth | null {
    const active = this.activeChannels.get(channelId);
    if (active) return active.adapter.health();
    return null;
  }

  listActive(): string[] {
    return Array.from(this.activeChannels.keys());
  }

  startAll(): void {
    const rows = this.db.prepare('SELECT id, type, config_json, secret_ref, enabled, status FROM channels WHERE enabled = 1').all() as ChannelRow[];
    for (const row of rows) {
      if (row.status !== 'connected') {
        this.start(row.id).catch((err) => {
          this.logger.error({ err, channelId: row.id }, 'ChannelManager.startAll: failed to start channel');
        });
      }
    }
    // Health check every 30 seconds
    this.healthInterval = setInterval(() => this._healthCheck(), 30000);
  }

  stopAll(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
    for (const [channelId] of this.activeChannels) {
      this.stop(channelId).catch(() => {});
    }
  }

  /** Check if an event is a duplicate */
  isDuplicate(channelId: string, externalEventId: string): boolean {
    const key = `${channelId}:${externalEventId}`;
    const now = Date.now();
    // Clean old entries (older than 5 minutes)
    for (const [k, time] of this.dedupCache) {
      if (now - time > 300000) this.dedupCache.delete(k);
    }
    if (this.dedupCache.has(key)) return true;
    // Also check DB
    const existing = this.db.prepare(
      'SELECT status FROM channel_events WHERE channel_id = ? AND external_event_id = ? AND direction = ?',
    ).get(channelId, externalEventId, 'inbound') as { status: string } | undefined;
    if (existing) return true;
    this.dedupCache.set(key, now);
    return false;
  }

  /** Record an inbound event in the database */
  recordEvent(channelId: string, externalEventId: string, direction: 'inbound' | 'outbound', payload: unknown): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO channel_events (channel_id, external_event_id, direction, payload_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(channelId, externalEventId, direction, JSON.stringify(payload), 'received', now);
  }

  /** Mark an event as processed */
  markProcessed(channelId: string, externalEventId: string): void {
    this.db.prepare(
      'UPDATE channel_events SET status = ? WHERE channel_id = ? AND external_event_id = ? AND direction = ?',
    ).run('processed', channelId, externalEventId, 'inbound');
  }

  /** Find or create a project binding for an external conversation */
  async getOrCreateBinding(channelId: string, externalConversationId: string, externalUserId: string, text: string): Promise<{ projectId: string | null; isNew: boolean }> {
    // Check existing binding
    const binding = this.db.prepare(
      'SELECT project_id FROM channel_bindings WHERE channel_id = ? AND external_conversation_id = ?',
    ).get(channelId, externalConversationId) as { project_id: string } | undefined;
    if (binding) return { projectId: binding.project_id, isNew: false };

    // Check for new project command
    const trimmed = text.trim();
    if (trimmed === '/new' || trimmed.startsWith('/new ')) {
      // Create a new project using the full project-creator flow
      const projectName = trimmed.replace('/new', '').trim() || `Chat-${externalConversationId}`;
      const result = await createProject(this.db, {
        content: { schemaVersion: 1, text: projectName },
      });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      const projectId = result.data.id;
      this._createBinding(channelId, externalConversationId, projectId);
      return { projectId, isNew: true };
    }

    // Check for /use command
    if (trimmed.startsWith('/use ')) {
      const shortId = trimmed.slice(5).trim();
      const project = this.db.prepare(
        'SELECT id FROM projects WHERE id LIKE ? LIMIT 1',
      ).get(`%${shortId}%`) as { id: string } | undefined;
      if (project) {
        this._createBinding(channelId, externalConversationId, project.id);
        return { projectId: project.id, isNew: true };
      }
    }

    // No binding and no command - return null (privacy prompt needed)
    return { projectId: null, isNew: false };
  }

  /** List channel bindings with joined channel/project info */
  listBindings(channelId?: string): Array<{
    channelId: string;
    channelName: string;
    channelType: string;
    externalConversationId: string;
    projectId: string;
    projectName: string;
    createdAt: string;
  }> {
    const where = channelId ? 'WHERE cb.channel_id = ?' : '';
    const params = channelId ? [channelId] : [];
    return this.db.prepare(`
      SELECT cb.channel_id AS channelId, c.name AS channelName, c.type AS channelType,
             cb.external_conversation_id AS externalConversationId,
             cb.project_id AS projectId, p.name AS projectName,
             cb.created_at AS createdAt
      FROM channel_bindings cb
      JOIN channels c ON c.id = cb.channel_id
      LEFT JOIN projects p ON p.id = cb.project_id
      ${where}
      ORDER BY cb.created_at DESC
    `).all(...params) as Array<{
      channelId: string;
      channelName: string;
      channelType: string;
      externalConversationId: string;
      projectId: string;
      projectName: string;
      createdAt: string;
    }>;
  }

  /** Preview an external conversation before binding */
  async previewConversation(
    channelId: string,
    externalConversationId: string,
  ): Promise<{ ok: boolean; data?: { name?: string; exists: boolean; verified: boolean; error?: string }; error?: string }> {
    const row = this.db.prepare('SELECT id, type, config_json, secret_ref FROM channels WHERE id = ?').get(channelId) as ChannelRow | undefined;
    if (!row) return { ok: false, error: '渠道不存在' };
    const adapter = this.adapters.get(row.type);
    if (!adapter) return { ok: false, error: `不支持的渠道类型: ${row.type}` };
    if (!adapter.getConversationInfo) {
      return { ok: true, data: { exists: true, verified: false } };
    }
    try {
      const config = this._resolveConfig(row);
      const info = await adapter.getConversationInfo({ conversationId: externalConversationId }, config);
      return {
        ok: true,
        data: {
          exists: info.exists,
          verified: true,
          ...(info.name ? { name: info.name } : {}),
          ...(info.error ? { error: info.error } : {}),
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Bind an external conversation to a project (manual binding) */
  async bindConversation(
    channelId: string,
    externalConversationId: string,
    projectId: string,
    force = false,
  ): Promise<{ ok: boolean; data?: { alreadyBound?: string }; error?: { code: string; message: string; retryable: boolean } }> {
    const channel = this.db.prepare('SELECT type FROM channels WHERE id = ?').get(channelId) as { type: string } | undefined;
    if (!channel) return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: '渠道不存在', retryable: false } };
    if (channel.type === 'wecom-webhook') {
      return { ok: false, error: { code: 'CHANNEL_NOT_BINDABLE', message: '该渠道仅支持出站，无法绑定会话', retryable: false } };
    }
    const project = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as { id: string } | undefined;
    if (!project) return { ok: false, error: { code: 'PROJECT_NOT_FOUND', message: '项目不存在', retryable: false } };

    const existing = this.db.prepare(
      'SELECT project_id FROM channel_bindings WHERE channel_id = ? AND external_conversation_id = ?',
    ).get(channelId, externalConversationId) as { project_id: string } | undefined;

    if (existing && existing.project_id === projectId) {
      return { ok: true, data: { alreadyBound: projectId } };
    }
    if (existing && !force) {
      return { ok: false, error: { code: 'ALREADY_BOUND', message: '该会话已绑定到其他项目', retryable: false } };
    }

    this._createBinding(channelId, externalConversationId, projectId);
    return existing
      ? { ok: true, data: { alreadyBound: existing.project_id } }
      : { ok: true };
  }

  /** Remove a channel binding (does not touch messages or events) */
  async unbindConversation(channelId: string, externalConversationId: string): Promise<{ ok: boolean }> {
    this.db.prepare(
      'DELETE FROM channel_bindings WHERE channel_id = ? AND external_conversation_id = ?',
    ).run(channelId, externalConversationId);
    return { ok: true };
  }

  /** Process a text command */
  processCommand(text: string, channelId: string, externalConversationId: string): { response: string; action: 'new' | 'use' | 'stop' | 'status' | 'projects' | 'help' | 'id' | 'none' } {
    const trimmed = text.trim();
    if (trimmed === '/new' || trimmed.startsWith('/new ')) {
      return { response: '正在创建新项目...', action: 'new' };
    }
    if (trimmed === '/projects') {
      const projects = this.db.prepare('SELECT id, name FROM projects ORDER BY created_at DESC LIMIT 10').all() as Array<{ id: string; name: string }>;
      const list = projects.map((p) => `  • \`${p.id.slice(0, 8)}\` — ${p.name}`).join('\n');
      return { response: `当前项目:\n${list || '  暂无项目'}`, action: 'projects' };
    }
    if (trimmed.startsWith('/use ')) {
      return { response: '正在查找项目...', action: 'use' };
    }
    if (trimmed === '/stop') {
      return { response: '正在停止当前运行...', action: 'stop' };
    }
    if (trimmed === '/status') {
      const health = this.health(channelId);
      const status = health?.connected ? '已连接' : '未连接';
      return { response: `渠道状态: ${status}\n活跃时间: ${health?.uptimeMs ? `${Math.round(health.uptimeMs / 1000)}秒` : 'N/A'}`, action: 'status' };
    }
    if (trimmed === '/id') {
      const row = this.db.prepare('SELECT type FROM channels WHERE id = ?').get(channelId) as { type: string } | undefined;
      const typeLabel = row ? (CHANNEL_TYPE_LABELS[row.type] ?? row.type) : '未知';
      return {
        response: `会话 ID: \`${externalConversationId}\`\n渠道: ${typeLabel}\n在应用的「绑定渠道会话」中粘贴此 ID 即可绑定到项目。`,
        action: 'id',
      };
    }
    if (trimmed === '/help') {
      return {
        response: '可用命令:\n  `/new [名称]` — 创建新项目\n  `/projects` — 列出项目\n  `/use <shortId>` — 绑定到已有项目\n  `/id` — 查看当前会话 ID\n  `/stop` — 停止当前运行\n  `/status` — 查看渠道状态\n  `/help` — 显示此帮助',
        action: 'help',
      };
    }
    return { response: '', action: 'none' };
  }

  private async _handleInbound(channelId: string, event: InboundChannelEvent): Promise<void> {
    // Dedup
    if (this.isDuplicate(channelId, event.externalEventId)) return;
    this.recordEvent(channelId, event.externalEventId, 'inbound', event);

    // Process command or route to agent
    const cmdResult = this.processCommand(event.text, channelId, event.externalConversationId);
    if (cmdResult.action !== 'none') {
      // Handle /stop: cancel only runs triggered by this user in the bound project
      if (cmdResult.action === 'stop') {
        const binding = await this.getOrCreateBinding(channelId, event.externalConversationId, event.externalUserId, event.text);
        const activeRuns: Array<{ id: string }> = [];
        if (binding.projectId) {
          const runs = this.db.prepare(
            "SELECT id FROM agent_runs WHERE project_id = ? AND status IN ('queued', 'starting', 'running') AND requested_by_id = ?",
          ).all(binding.projectId, event.externalUserId) as Array<{ id: string }>;
          activeRuns.push(...runs);
          for (const run of activeRuns) {
            this.db.prepare(
              "UPDATE agent_runs SET status = 'cancelled', finished_at = ? WHERE id = ?",
            ).run(new Date().toISOString(), run.id);
          }
          this._emitEvent({ type: 'channel.stop', channelId, data: { projectId: binding.projectId, runIds: activeRuns.map((r) => r.id) } });
        }
        this._sendReply(channelId, event.externalConversationId, activeRuns.length > 0 ? `已取消 ${activeRuns.length} 个运行` : '当前没有正在运行的对话');
        this.markProcessed(channelId, event.externalEventId);
        return;
      }

      // For /new and /use, don't return early — let them fall through to getOrCreateBinding
      if (cmdResult.action !== 'new' && cmdResult.action !== 'use') {
        this._sendReply(channelId, event.externalConversationId, cmdResult.response);
        this.markProcessed(channelId, event.externalEventId);
        return;
      }
    }

    // Check binding (creates project for /new, binds for /use)
    let binding: { projectId: string | null; isNew: boolean };
    try {
      binding = await this.getOrCreateBinding(channelId, event.externalConversationId, event.externalUserId, event.text);
    } catch (err) {
      this.logger.error({ err, channelId }, 'ChannelManager: failed to create/find binding');
      this._sendReply(channelId, event.externalConversationId, `操作失败: ${err instanceof Error ? err.message : String(err)}`);
      this.markProcessed(channelId, event.externalEventId);
      return;
    }

    if (!binding.projectId) {
      // No binding - show privacy prompt
      this._sendReply(channelId, event.externalConversationId,
        '欢迎使用鲲擎！\n\n您尚未绑定此会话到任何项目。请使用以下命令开始：\n' +
        '  `/new [名称]` — 创建新项目\n' +
        '  `/projects` — 查看已有项目\n' +
        '  `/use <shortId>` — 绑定到已有项目\n' +
        '  `/id` — 查看当前会话 ID（可在应用内绑定到项目）\n' +
        '  `/help` — 查看所有命令\n\n' +
        '注意：您的消息将被发送到鲲擎智能体处理。');
      this.markProcessed(channelId, event.externalEventId);
      return;
    }

    // If this was a /new or /use command, send the response and stop
    if (cmdResult.action === 'new') {
      const projectName = event.text.replace('/new', '').trim() || '新项目';
      this._sendReply(channelId, event.externalConversationId, `项目「${projectName}」已创建，可以开始对话了！`);
      this.markProcessed(channelId, event.externalEventId);
      return;
    }
    if (cmdResult.action === 'use') {
      this._sendReply(channelId, event.externalConversationId, '已绑定到指定项目，可以开始对话了！');
      this.markProcessed(channelId, event.externalEventId);
      return;
    }

    // Async processing: download attachments → write message → route to agent
    this._startProcessingStatus(channelId, event.externalConversationId);
    this._processInboundAsync(channelId, event, binding.projectId).catch((err) => {
      this.logger.error({ err, channelId }, 'ChannelManager: error processing inbound message');
      this._stopProcessingStatus(channelId, event.externalConversationId);
    });
    this.markProcessed(channelId, event.externalEventId);
  }

  private async _processInboundAsync(channelId: string, event: InboundChannelEvent, projectId: string): Promise<void> {
    // 1. Download and import attachments
    const importedAttachments: Array<{ fileId: string; fileName: string; mimeType: string; size: number }> = [];
    if (event.attachments && event.attachments.length > 0) {
      for (const att of event.attachments) {
        const downloaded = await this.downloadAttachment(att, projectId);
        if (downloaded) {
          const fileId = this.importAttachment(
            downloaded.localPath, att.fileName, downloaded.sha256,
            downloaded.size, downloaded.mimeType, projectId,
          );
          if (fileId) {
            importedAttachments.push({ fileId, fileName: att.fileName, mimeType: downloaded.mimeType, size: downloaded.size });
          }
        }
      }
    }

    // 2. Write user message
    const msgRepo = new MessageRepository(this.db);
    const contentJson = JSON.stringify({
      schemaVersion: 1,
      text: event.text,
      channelId,
      externalEventId: event.externalEventId,
      externalConversationId: event.externalConversationId,
      externalUserId: event.externalUserId,
      attachments: importedAttachments,
    });
    msgRepo.createUserMessage(projectId, contentJson);

    // 3. Route to agent
    this._routeToAgent(channelId, event, projectId, importedAttachments);
  }

  private _handleError(channelId: string, error: Error): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE channels SET last_error = ?, updated_at = ? WHERE id = ?').run(error.message, now, channelId);
    this._emitEvent({ type: 'channel.error', channelId, data: { error: error.message } });
  }

  private _updateStatus(channelId: string, status: ChannelStatus): void {
    this.db.prepare('UPDATE channels SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), channelId);
    this._emitEvent({ type: 'channel.status', channelId, data: { status } });
  }

  /** Split a message into chunks respecting channel length limits */
  private _chunkMessage(channelId: string, text: string): string[] {
    const maxLen = CHANNEL_MAX_MESSAGE_LENGTH[channelId] ?? 4096;
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLen) {
      chunks.push(text.slice(i, i + maxLen));
    }
    // Add chunk indicator
    return chunks.map((chunk, idx) => (chunks.length > 1 ? `(${idx + 1}/${chunks.length}) ${chunk}` : chunk));
  }

  /** Send a single "processing" status message for a channel conversation */
  private _startProcessingStatus(channelId: string, conversationId: string): void {
    const key = `${channelId}:${conversationId}`;
    if (this.processingTimers.has(key)) return;
    // Send a single "processing" message — no timer to avoid spamming the chat
    this.send(channelId, { conversationId }, { text: '处理中...' }).catch(() => {});
    this.processingTimers.set(key, true);
  }

  /** Clear processing status so the next message sends the actual reply */
  private _stopProcessingStatus(channelId: string, conversationId: string): void {
    const key = `${channelId}:${conversationId}`;
    this.processingTimers.delete(key);
  }

  private async _sendReply(channelId: string, conversationId: string, text: string): Promise<void> {
    // Stop processing status updates before sending the final reply
    this._stopProcessingStatus(channelId, conversationId);
    const chunks = this._chunkMessage(channelId, text);
    for (const chunk of chunks) {
      try {
        await this.send(channelId, { conversationId }, { text: chunk });
      } catch (err) {
        this.logger.error({ err, channelId, conversationId }, 'ChannelManager: failed to send reply');
      }
    }
  }

  private _routeToAgent(
    channelId: string,
    event: InboundChannelEvent,
    projectId: string,
    importedAttachments?: Array<{ fileId: string; fileName: string; mimeType: string; size: number }>,
  ): void {
    // Emit an event that the scheduler can pick up
    this._emitEvent({
      type: 'channel.message',
      channelId,
      data: {
        projectId,
        externalConversationId: event.externalConversationId,
        externalUserId: event.externalUserId,
        text: event.text,
        attachments: importedAttachments ?? [],
        receivedAt: event.receivedAt,
        externalEventId: event.externalEventId,
      },
    });
  }

  /** Validate MIME type against allowed list */
  private _validateMime(mimeType: string): boolean {
    return ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
  }

  /**
   * Download a remote attachment to a temporary directory and validate it.
   * Returns the local file path and validated metadata, or null if validation fails.
   */
  async downloadAttachment(attachment: RemoteAttachment, projectId: string): Promise<{
    localPath: string;
    sha256: string;
    size: number;
    mimeType: string;
  } | null> {
    // Validate size
    if (attachment.sizeBytes > MAX_ATTACHMENT_BYTES) {
      this.logger.warn({ fileName: attachment.fileName, sizeBytes: attachment.sizeBytes }, 'ChannelManager: attachment too large');
      return null;
    }

    // Validate MIME
    if (!this._validateMime(attachment.mimeType)) {
      this.logger.warn({ mimeType: attachment.mimeType }, 'ChannelManager: unsupported MIME type');
      return null;
    }

    // Download to temp directory
    const tmpDir = join(getProjectRoot(projectId), '.runtime', 'channel-attachments');
    if (!existsSync(tmpDir)) {
      await mkdir(tmpDir, { recursive: true });
    }

    const safeName = `${randomUUID().slice(0, 12)}_${basename(attachment.fileName).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const localPath = join(tmpDir, safeName);

    try {
      const resp = await fetch(attachment.downloadUrl, { signal: AbortSignal.timeout(30000) });
      if (!resp.ok) {
        this.logger.warn({ status: resp.status, statusText: resp.statusText, fileName: attachment.fileName }, 'ChannelManager: failed to download attachment');
        return null;
      }
      const buf = Buffer.from(await resp.arrayBuffer());

      // Verify actual MIME from response headers
      const actualMime = resp.headers.get('content-type') ?? attachment.mimeType;
      if (!this._validateMime(actualMime)) {
        this.logger.warn({ actualMime, fileName: attachment.fileName }, 'ChannelManager: actual MIME type not allowed');
        return null;
      }

      // Verify actual size
      if (buf.length > MAX_ATTACHMENT_BYTES) {
        this.logger.warn({ size: buf.length, fileName: attachment.fileName }, 'ChannelManager: downloaded file too large');
        return null;
      }

      await writeFile(localPath, buf);
      const sha256 = createHash('sha256').update(buf).digest('hex');

      return { localPath, sha256, size: buf.length, mimeType: actualMime };
    } catch (err) {
      this.logger.warn({ err, fileName: attachment.fileName }, 'ChannelManager: download error');
      return null;
    }
  }

  /** Import a downloaded attachment into the project's workspace */
  importAttachment(
    localPath: string,
    fileName: string,
    sha256: string,
    size: number,
    mimeType: string,
    projectId: string,
  ): string | null {
    try {
      const fileRepo = new FileRepository(this.db);
      const storageRelPath = join('.runtime', 'channel-attachments', basename(localPath));
      const normalizedPath = `channel/${fileName}`;

      const file = fileRepo.create({
        scopeType: 'project',
        scopeId: projectId,
        parentId: 'channel',
        type: 'file',
        name: fileName,
        normalizedPath,
        mimeType,
        origin: 'imported',
      });
      fileRepo.createVersion({
        fileId: file.id,
        storageRelPath,
        size,
        sha256,
        createdByType: 'user',
        createdById: 'channel-remote',
        changeNote: 'channel-attachment',
      });
      fileRepo.markReady(file.id);
      return file.id;
    } catch (err) {
      this.logger.warn({ err, fileName }, 'ChannelManager: failed to import attachment');
      return null;
    }
  }

  /** Redact sensitive fields from an object for safe logging */
  private _redact(obj: Record<string, unknown>): Record<string, unknown> {
    const sensitiveKeys = ['token', 'secret', 'password', 'key', 'app_secret', 'app_key', 'client_secret', 'client_id', 'webhook_url'];
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (sensitiveKeys.some((sk) => k.toLowerCase().includes(sk))) {
        result[k] = typeof v === 'string' && v.length > 8 ? `${v.slice(0, 4)}****${v.slice(-4)}` : '****';
      } else if (typeof v === 'object' && v !== null) {
        result[k] = this._redact(v as Record<string, unknown>);
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  private _resolveConfig(row: ChannelRow): ResolvedChannelConfig {
    const config = row.config_json ? JSON.parse(row.config_json) : {};
    const secrets: Record<string, string> = {};
    // Resolve secrets from the secrets table if secret_ref is set
    if (row.secret_ref) {
      try {
        const secret = this.db.prepare('SELECT ciphertext FROM secrets WHERE id = ?').get(row.secret_ref) as { ciphertext: Buffer } | undefined;
        if (secret && safeStorage.isEncryptionAvailable()) {
          const decrypted = safeStorage.decryptString(secret.ciphertext);
          secrets.token = decrypted;
        }
      } catch {
        // If decryption fails, leave secrets empty
      }
    }
    return { type: row.type as ChannelType, config, secrets };
  }

  private _createBinding(channelId: string, externalConversationId: string, projectId: string): void {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      'INSERT OR IGNORE INTO channel_bindings (channel_id, external_conversation_id, project_id, created_at) VALUES (?, ?, ?, ?)',
    ).run(channelId, externalConversationId, projectId, now);
    if (result.changes === 0) {
      this.db.prepare(
        'UPDATE channel_bindings SET project_id = ? WHERE channel_id = ? AND external_conversation_id = ?',
      ).run(projectId, channelId, externalConversationId);
    }
  }

  /** Calculate exponential backoff delay with jitter (in ms) */
  private _backoffDelay(channelId: string): number {
    const baseDelay = 1000; // 1 second
    const maxDelay = 300000; // 5 minutes
    const retryCount = this.retryCounts.get(channelId) ?? 0;
    const exponential = Math.min(baseDelay * Math.pow(2, retryCount), maxDelay);
    // Add jitter: random ±25% of the delay
    const jitter = exponential * (0.75 + Math.random() * 0.5);
    return Math.round(jitter);
  }

  private _scheduleRetry(channelId: string): void {
    // Clear existing retry timer
    const existing = this.retryTimers.get(channelId);
    if (existing) clearTimeout(existing);

    const delay = this._backoffDelay(channelId);
    const retryCount = (this.retryCounts.get(channelId) ?? 0) + 1;
    this.retryCounts.set(channelId, retryCount);

    this.logger.info({ channelId, delay, retryCount }, 'ChannelManager: scheduling retry');

    const timer = setTimeout(() => {
      this.retryTimers.delete(channelId);
      const row = this.db.prepare('SELECT id, type, config_json, secret_ref, enabled FROM channels WHERE id = ?').get(channelId) as ChannelRow | undefined;
      if (row?.enabled && !this.activeChannels.has(channelId)) {
        this.start(channelId).catch(() => {});
      }
    }, delay);
    this.retryTimers.set(channelId, timer);
  }

  private _healthCheck(): void {
    for (const [channelId, active] of this.activeChannels) {
      try {
        const health = active.adapter.health();
        if (!health.connected) {
          this._updateStatus(channelId, 'error');
          this.activeChannels.delete(channelId);
          this._scheduleRetry(channelId);
        }
      } catch { /* ignore */ }
    }
  }

  /** Reset retry count on successful connection */
  private _resetRetry(channelId: string): void {
    this.retryCounts.delete(channelId);
    const timer = this.retryTimers.get(channelId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(channelId);
    }
  }

  private _emitEvent(event: { type: string; channelId: string; data: unknown }): void {
    this.logger.debug({ type: event.type, channelId: event.channelId, data: event.data }, 'ChannelManager._emitEvent');
    this.eventCallback?.(event);
  }
}