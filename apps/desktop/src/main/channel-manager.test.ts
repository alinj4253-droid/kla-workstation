// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { ChannelManager } from './channel-manager';
import { createProject } from './project-creator';

vi.mock('./project-creator', async () => {
  const actual = await vi.importActual('./project-creator') as typeof import('./project-creator');
  return {
    ...actual,
    createProject: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// AC-CHANNEL-03: 命令解析正确路由
// AC-CHANNEL-04: 事件去重
// AC-CHANNEL-05: 健康检查状态管理
// AC-CHANNEL-06: 指数退避正确计算
// ---------------------------------------------------------------------------

describe('AC-CHANNEL-03: 命令解析', () => {
  let db: Database.Database;
  let tmpDir: string;
  let mgr: ChannelManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'channel-mgr-03-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.exec(`
      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('telegram','lark','dingtalk','wecom-webhook')),
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'disconnected' CHECK(status IN ('disconnected','connecting','connected','error')),
        config_json TEXT,
        secret_ref TEXT,
        last_connected_at TEXT,
        last_error TEXT,
        last_test_result TEXT,
        last_tested_at TEXT,
        updated_at TEXT,
        created_at TEXT
      );
      CREATE TABLE channel_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        external_event_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        payload_json TEXT,
        status TEXT NOT NULL DEFAULT 'received',
        created_at TEXT NOT NULL
      );
      CREATE TABLE channel_bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        external_conversation_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE secrets (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE idempotency_requests (
        key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    mgr = new ChannelManager(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('"/new" 命令返回 new 动作', () => {
    const result = mgr.processCommand('/new', 'ch-1', 'conv-1');
    expect(result.action).toBe('new');
    expect(result.response).toContain('创建新项目');
  });

  it('"/new 项目名称" 包含自定义名称', () => {
    const result = mgr.processCommand('/new 测试项目', 'ch-1', 'conv-1');
    expect(result.action).toBe('new');
  });

  it('"/projects" 命令返回 projects 动作', () => {
    const result = mgr.processCommand('/projects', 'ch-1', 'conv-1');
    expect(result.action).toBe('projects');
    expect(result.response).toContain('当前项目');
  });

  it('"/use <id>" 命令返回 use 动作', () => {
    const result = mgr.processCommand('/use abc123', 'ch-1', 'conv-1');
    expect(result.action).toBe('use');
  });

  it('"/stop" 命令返回 stop 动作', () => {
    const result = mgr.processCommand('/stop', 'ch-1', 'conv-1');
    expect(result.action).toBe('stop');
    expect(result.response).toContain('正在停止');
  });

  it('"/status" 命令返回 status 动作', () => {
    const result = mgr.processCommand('/status', 'ch-1', 'conv-1');
    expect(result.action).toBe('status');
    expect(result.response).toContain('渠道状态');
  });

  it('"/help" 命令返回 help 动作', () => {
    const result = mgr.processCommand('/help', 'ch-1', 'conv-1');
    expect(result.action).toBe('help');
    expect(result.response).toContain('/new');
  });

  it('普通文本返回 none 动作', () => {
    const result = mgr.processCommand('你好，鲲擎', 'ch-1', 'conv-1');
    expect(result.action).toBe('none');
    expect(result.response).toBe('');
  });

  it('空白文本返回 none 动作', () => {
    const result = mgr.processCommand('', 'ch-1', 'conv-1');
    expect(result.action).toBe('none');
  });
});

describe('AC-CHANNEL-04: 事件去重', () => {
  let db: Database.Database;
  let tmpDir: string;
  let mgr: ChannelManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'channel-mgr-04-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.exec(`
      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'disconnected',
        config_json TEXT,
        secret_ref TEXT,
        last_connected_at TEXT,
        last_error TEXT,
        last_test_result TEXT,
        last_tested_at TEXT,
        updated_at TEXT,
        created_at TEXT
      );
      CREATE TABLE channel_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        external_event_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        payload_json TEXT,
        status TEXT NOT NULL DEFAULT 'received',
        created_at TEXT NOT NULL
      );
      CREATE TABLE channel_bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        external_conversation_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE secrets (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE idempotency_requests (
        key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    mgr = new ChannelManager(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('相同事件 ID 被识别为重复', () => {
    expect(mgr.isDuplicate('ch-1', 'evt-1')).toBe(false);
    expect(mgr.isDuplicate('ch-1', 'evt-1')).toBe(true);
  });

  it('不同事件 ID 不被识别为重复', () => {
    expect(mgr.isDuplicate('ch-1', 'evt-1')).toBe(false);
    expect(mgr.isDuplicate('ch-1', 'evt-2')).toBe(false);
  });

  it('不同渠道相同事件 ID 不重复', () => {
    expect(mgr.isDuplicate('ch-1', 'evt-1')).toBe(false);
    expect(mgr.isDuplicate('ch-2', 'evt-1')).toBe(false);
  });

  it('记录事件后 isDuplicate 返回 true', () => {
    mgr.recordEvent('ch-1', 'evt-1', 'inbound', { text: 'hello' });
    expect(mgr.isDuplicate('ch-1', 'evt-1')).toBe(true);
  });

  it('标记处理后的历史事件仍被识别为重复', () => {
    mgr.recordEvent('ch-1', 'evt-1', 'inbound', { text: 'hello' });
    mgr.markProcessed('ch-1', 'evt-1');
    expect(mgr.isDuplicate('ch-1', 'evt-1')).toBe(true);
  });
});

describe('AC-CHANNEL-05: 渠道状态管理', () => {
  let db: Database.Database;
  let tmpDir: string;
  let mgr: ChannelManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'channel-mgr-05-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.exec(`
      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'disconnected',
        config_json TEXT,
        secret_ref TEXT,
        last_connected_at TEXT,
        last_error TEXT,
        last_test_result TEXT,
        last_tested_at TEXT,
        updated_at TEXT,
        created_at TEXT
      );
      CREATE TABLE channel_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        external_event_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        payload_json TEXT,
        status TEXT NOT NULL DEFAULT 'received',
        created_at TEXT NOT NULL
      );
      CREATE TABLE channel_bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        external_conversation_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE secrets (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE idempotency_requests (
        key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    mgr = new ChannelManager(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('不存在的渠道 getChannelStatus 返回 null', () => {
    const status = mgr.getChannelStatus('non-existent');
    expect(status.adapter).toBeNull();
    expect(status.started).toBe(false);
  });

  it('已注册渠道但未启动时返回 adapter 和 started=false', () => {
    db.prepare('INSERT INTO channels (id, type, name, config_json) VALUES (?, ?, ?, ?)').run('ch-1', 'telegram', 'Bot', '{}');
    const status = mgr.getChannelStatus('ch-1');
    expect(status.adapter).not.toBeNull();
    expect(status.started).toBe(false);
  });

  it('未测试渠道的测试返回失败', async () => {
    db.prepare('INSERT INTO channels (id, type, name, config_json) VALUES (?, ?, ?, ?)').run('ch-1', 'telegram', 'Bot', '{}');
    const result = await mgr.test('ch-1');
    // Telegram test requires a real token, so it will fail
    expect(result.success).toBe(false);
  });

  it('不存在的渠道测试返回错误', async () => {
    const result = await mgr.test('non-existent');
    expect(result.success).toBe(false);
    expect(result.message).toContain('不存在');
  });

  it('不支持的渠道类型测试返回错误', async () => {
    db.prepare('INSERT INTO channels (id, type, name, config_json) VALUES (?, ?, ?, ?)').run('ch-1', 'invalid-type', 'Bot', '{}');
    const result = await mgr.test('ch-1');
    expect(result.success).toBe(false);
    expect(result.message).toContain('不支持');
  });
});

describe('AC-CHANNEL-06: 项目绑定逻辑', () => {
  let db: Database.Database;
  let tmpDir: string;
  let mgr: ChannelManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'channel-mgr-06-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.exec(`
      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'disconnected',
        config_json TEXT,
        secret_ref TEXT,
        last_connected_at TEXT,
        last_error TEXT,
        last_test_result TEXT,
        last_tested_at TEXT,
        updated_at TEXT,
        created_at TEXT
      );
      CREATE TABLE channel_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        external_event_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        payload_json TEXT,
        status TEXT NOT NULL DEFAULT 'received',
        created_at TEXT NOT NULL
      );
      CREATE TABLE channel_bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        external_conversation_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE secrets (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE idempotency_requests (
        key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    mgr = new ChannelManager(db);
    // Mock createProject to return a predictable project ID
    (createProject as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { id: 'mock-project-id', status: 'active', createdAt: new Date().toISOString() },
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('未绑定会话的普通消息返回 null projectId', async () => {
    const result = await mgr.getOrCreateBinding('ch-1', 'conv-1', 'user-1', '你好');
    expect(result.projectId).toBeNull();
    expect(result.isNew).toBe(false);
  });

  it('/new 命令创建新项目并绑定', async () => {
    const result = await mgr.getOrCreateBinding('ch-1', 'conv-1', 'user-1', '/new');
    expect(result.projectId).toBe('mock-project-id');
    expect(result.isNew).toBe(true);

    // Verify binding exists
    const binding = db.prepare('SELECT project_id FROM channel_bindings WHERE channel_id = ? AND external_conversation_id = ?').get('ch-1', 'conv-1') as { project_id: string };
    expect(binding).toBeDefined();
    expect(binding.project_id).toBe('mock-project-id');
  });

  it('/new 自定义名称创建项目', async () => {
    const result = await mgr.getOrCreateBinding('ch-1', 'conv-1', 'user-1', '/new 测试项目');
    expect(result.projectId).toBe('mock-project-id');
    expect(result.isNew).toBe(true);

    // Verify createProject was called with the custom name
    expect(createProject).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        content: expect.objectContaining({ text: '测试项目' }),
      }),
    );
  });

  it('已绑定会话返回已有 projectId', async () => {
    // First call creates binding
    const first = await mgr.getOrCreateBinding('ch-1', 'conv-1', 'user-1', '/new');
    // Second call should return the same binding
    const second = await mgr.getOrCreateBinding('ch-1', 'conv-1', 'user-1', '普通消息');
    expect(second.projectId).toBe(first.projectId);
    expect(second.isNew).toBe(false);
  });
});

describe('AC-CHANNEL-07: 消息分块', () => {
  let db: Database.Database;
  let tmpDir: string;
  let mgr: ChannelManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'channel-mgr-07-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.exec(`CREATE TABLE channels (id TEXT PRIMARY KEY,type TEXT NOT NULL,name TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'disconnected',config_json TEXT,secret_ref TEXT,last_connected_at TEXT,last_error TEXT,last_test_result TEXT,last_tested_at TEXT,updated_at TEXT,created_at TEXT);CREATE TABLE channel_events (id INTEGER PRIMARY KEY AUTOINCREMENT,channel_id TEXT NOT NULL,external_event_id TEXT NOT NULL,direction TEXT NOT NULL,payload_json TEXT,status TEXT NOT NULL DEFAULT 'received',created_at TEXT NOT NULL);CREATE TABLE channel_bindings (id INTEGER PRIMARY KEY AUTOINCREMENT,channel_id TEXT NOT NULL,external_conversation_id TEXT NOT NULL,project_id TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE secrets (id TEXT PRIMARY KEY,kind TEXT NOT NULL,ciphertext TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE idempotency_requests (key TEXT PRIMARY KEY,operation TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);`);
    mgr = new ChannelManager(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('短消息不分块', () => {
    const chunks = mgr['_chunkMessage']('telegram', 'hello');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('hello');
  });

  it('超长消息按 channel 限制分块', () => {
    // Telegram max is 4096
    const longText = 'x'.repeat(5000);
    const chunks = mgr['_chunkMessage']('telegram', longText);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain('(1/2)');
  });
});

describe('AC-CHANNEL-08: 指数退避', () => {
  let db: Database.Database;
  let tmpDir: string;
  let mgr: ChannelManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'channel-mgr-08-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.exec(`CREATE TABLE channels (id TEXT PRIMARY KEY,type TEXT NOT NULL,name TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'disconnected',config_json TEXT,secret_ref TEXT,last_connected_at TEXT,last_error TEXT,last_test_result TEXT,last_tested_at TEXT,updated_at TEXT,created_at TEXT);CREATE TABLE channel_events (id INTEGER PRIMARY KEY AUTOINCREMENT,channel_id TEXT NOT NULL,external_event_id TEXT NOT NULL,direction TEXT NOT NULL,payload_json TEXT,status TEXT NOT NULL DEFAULT 'received',created_at TEXT NOT NULL);CREATE TABLE channel_bindings (id INTEGER PRIMARY KEY AUTOINCREMENT,channel_id TEXT NOT NULL,external_conversation_id TEXT NOT NULL,project_id TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE secrets (id TEXT PRIMARY KEY,kind TEXT NOT NULL,ciphertext TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE idempotency_requests (key TEXT PRIMARY KEY,operation TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);`);
    mgr = new ChannelManager(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('首次退避约 1 秒', () => {
    const delay = mgr['_backoffDelay']('ch-1');
    expect(delay).toBeGreaterThanOrEqual(500);
    expect(delay).toBeLessThanOrEqual(1500);
  });

  it('第二次退避约 2 秒', () => {
    mgr['retryCounts'].set('ch-1', 1);
    const delay = mgr['_backoffDelay']('ch-1');
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(3000);
  });

  it('多次重试后不超过 5 分钟（含抖动）', () => {
    mgr['retryCounts'].set('ch-1', 10);
    const delay = mgr['_backoffDelay']('ch-1');
    // baseDelay * 2^retryCount capped at 300000, plus 25% jitter = max ~375000
    expect(delay).toBeLessThanOrEqual(380000);
    expect(delay).toBeGreaterThanOrEqual(500);
  });
});

describe('AC-CHANNEL-09: 发送限流', () => {
  let db: Database.Database;
  let tmpDir: string;
  let mgr: ChannelManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'channel-mgr-09-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.exec(`CREATE TABLE channels (id TEXT PRIMARY KEY,type TEXT NOT NULL,name TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'disconnected',config_json TEXT,secret_ref TEXT,last_connected_at TEXT,last_error TEXT,last_test_result TEXT,last_tested_at TEXT,updated_at TEXT,created_at TEXT);CREATE TABLE channel_events (id INTEGER PRIMARY KEY AUTOINCREMENT,channel_id TEXT NOT NULL,external_event_id TEXT NOT NULL,direction TEXT NOT NULL,payload_json TEXT,status TEXT NOT NULL DEFAULT 'received',created_at TEXT NOT NULL);CREATE TABLE channel_bindings (id INTEGER PRIMARY KEY AUTOINCREMENT,channel_id TEXT NOT NULL,external_conversation_id TEXT NOT NULL,project_id TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE secrets (id TEXT PRIMARY KEY,kind TEXT NOT NULL,ciphertext TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE idempotency_requests (key TEXT PRIMARY KEY,operation TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);`);
    mgr = new ChannelManager(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('快速连续发送被限流', async () => {
    // Use a non-existent channel — send() returns immediately with '渠道不存在' (no retry)
    // This lets us test the rate limit without an actual adapter
    const first = await mgr.send('no-such-channel', { conversationId: 'c1' }, { text: 'msg1' });
    expect(first.ok).toBe(false);
    // Second send within 1 second window should be rate limited
    const result = await mgr.send('no-such-channel', { conversationId: 'c1' }, { text: 'msg2' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('频率');
  });
});

describe('AC-CHANNEL-10: 发送幂等', () => {
  let db: Database.Database;
  let tmpDir: string;
  let mgr: ChannelManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'channel-mgr-10-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.exec(`CREATE TABLE channels (id TEXT PRIMARY KEY,type TEXT NOT NULL,name TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'disconnected',config_json TEXT,secret_ref TEXT,last_connected_at TEXT,last_error TEXT,last_test_result TEXT,last_tested_at TEXT,updated_at TEXT,created_at TEXT);CREATE TABLE channel_events (id INTEGER PRIMARY KEY AUTOINCREMENT,channel_id TEXT NOT NULL,external_event_id TEXT NOT NULL,direction TEXT NOT NULL,payload_json TEXT,status TEXT NOT NULL DEFAULT 'received',created_at TEXT NOT NULL);CREATE TABLE channel_bindings (id INTEGER PRIMARY KEY AUTOINCREMENT,channel_id TEXT NOT NULL,external_conversation_id TEXT NOT NULL,project_id TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE secrets (id TEXT PRIMARY KEY,kind TEXT NOT NULL,ciphertext TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE idempotency_requests (key TEXT PRIMARY KEY,operation TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);`);
    mgr = new ChannelManager(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('idempotencyKey 命中缓存直接返回', async () => {
    // Seed an idempotency record so the send() returns cached result without calling adapter
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    db.prepare(
      'INSERT INTO idempotency_requests (key, operation, request_hash, result_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('cached-key', 'channel:send:ch-1', '', JSON.stringify({ ok: true, externalEventId: 'cached', error: null, sentAt: now }), expiresAt, now);

    const result = await mgr.send('ch-1', { conversationId: 'c1' }, { text: 'hello' }, 'cached-key');
    expect(result.ok).toBe(true);
    expect(result.externalEventId).toBe('cached');
  });

  it('不同 idempotencyKey 记录到不同条目', () => {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    // Insert two different idempotency records
    db.prepare(
      'INSERT INTO idempotency_requests (key, operation, request_hash, result_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('key-a', 'channel:send:ch-1', '', JSON.stringify({ ok: true, externalEventId: 'a' }), expiresAt, now);
    db.prepare(
      'INSERT INTO idempotency_requests (key, operation, request_hash, result_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('key-b', 'channel:send:ch-1', '', JSON.stringify({ ok: true, externalEventId: 'b' }), expiresAt, now);

    // Both are stored independently
    const a = db.prepare("SELECT result_json FROM idempotency_requests WHERE key = 'key-a'").get() as { result_json: string };
    const b = db.prepare("SELECT result_json FROM idempotency_requests WHERE key = 'key-b'").get() as { result_json: string };
    expect(JSON.parse(a.result_json).externalEventId).toBe('a');
    expect(JSON.parse(b.result_json).externalEventId).toBe('b');
  });
});

describe('AC-CHANNEL-11: 附件下载校验', () => {
  let db: Database.Database;
  let tmpDir: string;
  let mgr: ChannelManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'channel-mgr-11-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.exec(`CREATE TABLE channels (id TEXT PRIMARY KEY,type TEXT NOT NULL,name TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'disconnected',config_json TEXT,secret_ref TEXT,last_connected_at TEXT,last_error TEXT,last_test_result TEXT,last_tested_at TEXT,updated_at TEXT,created_at TEXT);CREATE TABLE channel_events (id INTEGER PRIMARY KEY AUTOINCREMENT,channel_id TEXT NOT NULL,external_event_id TEXT NOT NULL,direction TEXT NOT NULL,payload_json TEXT,status TEXT NOT NULL DEFAULT 'received',created_at TEXT NOT NULL);CREATE TABLE channel_bindings (id INTEGER PRIMARY KEY AUTOINCREMENT,channel_id TEXT NOT NULL,external_conversation_id TEXT NOT NULL,project_id TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE secrets (id TEXT PRIMARY KEY,kind TEXT NOT NULL,ciphertext TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE idempotency_requests (key TEXT PRIMARY KEY,operation TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);`);
    mgr = new ChannelManager(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('过大的附件被拒绝', async () => {
    const result = await mgr.downloadAttachment({
      externalId: 'f1', fileName: 'big.pdf', mimeType: 'application/pdf', sizeBytes: 200 * 1024 * 1024, downloadUrl: 'https://example.com/big.pdf',
    }, 'proj-1');
    expect(result).toBeNull();
  });

  it('不支持 MIME 的附件被拒绝', async () => {
    const result = await mgr.downloadAttachment({
      externalId: 'f2', fileName: 'script.exe', mimeType: 'application/x-msdownload', sizeBytes: 1000, downloadUrl: 'https://example.com/script.exe',
    }, 'proj-1');
    expect(result).toBeNull();
  });
});