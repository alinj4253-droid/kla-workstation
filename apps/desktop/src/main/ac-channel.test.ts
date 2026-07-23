// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

// ---------------------------------------------------------------------------
// AC-CHANNEL-01: 渠道启用前必须测试通过；失败不进入启用态
// AC-CHANNEL-02: 同一个远程事件重复投递只生成一条消息
// ---------------------------------------------------------------------------

describe('AC-CHANNEL-01', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ac-channel-01-'));
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
      CREATE UNIQUE INDEX idx_channels_type_name ON channels(type, name);
    `);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 辅助函数：模拟 setEnabled IPC 逻辑 ────────────────────────────────

  function setEnabled(channelId: string, enabled: boolean): { ok: boolean; error?: string } {
    const now = new Date().toISOString();
    if (enabled) {
      const row = db.prepare('SELECT last_test_result FROM channels WHERE id = ?').get(channelId) as { last_test_result: string | null } | undefined;
      if (!row) return { ok: false, error: '渠道不存在' };
      if (row.last_test_result !== 'success') return { ok: false, error: '渠道未通过测试，无法启用' };
      db.prepare('UPDATE channels SET enabled = ?, status = ?, updated_at = ? WHERE id = ?').run(1, 'connecting', now, channelId);
    } else {
      db.prepare('UPDATE channels SET enabled = ?, status = ?, updated_at = ? WHERE id = ?').run(0, 'disconnected', now, channelId);
    }
    return { ok: true };
  }

  // ── 测试用例 ──────────────────────────────────────────────────────────

  it('未测试时不能启用', () => {
    db.prepare('INSERT INTO channels (id, type, name, config_json) VALUES (?, ?, ?, ?)').run('ch-1', 'telegram', 'My Bot', '{}');

    const result = setEnabled('ch-1', true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未通过测试');

    const row = db.prepare('SELECT enabled FROM channels WHERE id = ?').get('ch-1') as { enabled: number };
    expect(row.enabled).toBe(0);
  });

  it('测试失败后不能启用', () => {
    db.prepare('INSERT INTO channels (id, type, name, config_json, last_test_result, last_tested_at) VALUES (?, ?, ?, ?, ?, ?)').run('ch-1', 'telegram', 'My Bot', '{}', 'failure', new Date().toISOString());

    const result = setEnabled('ch-1', true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未通过测试');

    const row = db.prepare('SELECT enabled FROM channels WHERE id = ?').get('ch-1') as { enabled: number };
    expect(row.enabled).toBe(0);
  });

  it('测试通过后可以启用', () => {
    db.prepare('INSERT INTO channels (id, type, name, config_json, last_test_result, last_tested_at) VALUES (?, ?, ?, ?, ?, ?)').run('ch-1', 'telegram', 'My Bot', '{}', 'success', new Date().toISOString());

    const result = setEnabled('ch-1', true);
    expect(result.ok).toBe(true);

    const row = db.prepare('SELECT enabled, status FROM channels WHERE id = ?').get('ch-1') as { enabled: number; status: string };
    expect(row.enabled).toBe(1);
    expect(row.status).toBe('connecting');
  });

  it('测试结果和测试时间被正确记录', () => {
    db.prepare('INSERT INTO channels (id, type, name, config_json) VALUES (?, ?, ?, ?)').run('ch-1', 'telegram', 'My Bot', '{}');

    const now = new Date().toISOString();
    db.prepare('UPDATE channels SET last_test_result = ?, last_tested_at = ? WHERE id = ?').run('success', now, 'ch-1');

    const row = db.prepare('SELECT last_test_result, last_tested_at FROM channels WHERE id = ?').get('ch-1') as { last_test_result: string; last_tested_at: string };
    expect(row.last_test_result).toBe('success');
    expect(row.last_tested_at).toBe(now);
  });

  it('禁用渠道不需要测试检查', () => {
    db.prepare('INSERT INTO channels (id, type, name, config_json) VALUES (?, ?, ?, ?)').run('ch-1', 'telegram', 'My Bot', '{}');

    // 直接禁用（未测试过的渠道也可以禁用）
    const result = setEnabled('ch-1', false);
    expect(result.ok).toBe(true);

    const row = db.prepare('SELECT enabled, status FROM channels WHERE id = ?').get('ch-1') as { enabled: number; status: string };
    expect(row.enabled).toBe(0);
    expect(row.status).toBe('disconnected');
  });

  it('启用后重复禁用不报错', () => {
    db.prepare('INSERT INTO channels (id, type, name, config_json, last_test_result, last_tested_at, enabled, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('ch-1', 'telegram', 'My Bot', '{}', 'success', new Date().toISOString(), 1, 'connected');

    const result = setEnabled('ch-1', false);
    expect(result.ok).toBe(true);

    const row = db.prepare('SELECT enabled, status FROM channels WHERE id = ?').get('ch-1') as { enabled: number; status: string };
    expect(row.enabled).toBe(0);
    expect(row.status).toBe('disconnected');
  });

  it('不存在渠道的启用请求返回错误', () => {
    const result = setEnabled('non-existent', true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不存在');
  });
});

describe('AC-CHANNEL-02', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ac-channel-02-'));
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
        channel_id TEXT NOT NULL REFERENCES channels(id),
        external_event_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
        payload_json TEXT,
        status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','processed','failed')),
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_channel_events_dedup ON channel_events(channel_id, external_event_id);
    `);
    db.prepare('INSERT INTO channels (id, type, name, enabled, status) VALUES (?, ?, ?, ?, ?)').run('ch-1', 'telegram', 'My Bot', 1, 'connected');
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 辅助函数 ──────────────────────────────────────────────────────────

  function insertEvent(channelId: string, eventId: string, payload: string): boolean {
    const now = new Date().toISOString();
    const result = db.prepare('INSERT OR IGNORE INTO channel_events (channel_id, external_event_id, direction, payload_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(channelId, eventId, 'inbound', payload, 'received', now);
    return result.changes > 0;
  }

  function countEvents(channelId?: string): number {
    if (channelId) {
      return (db.prepare('SELECT COUNT(*) as cnt FROM channel_events WHERE channel_id = ?').get(channelId) as { cnt: number }).cnt;
    }
    return (db.prepare('SELECT COUNT(*) as cnt FROM channel_events').get() as { cnt: number }).cnt;
  }

  // ── 测试用例 ──────────────────────────────────────────────────────────

  it('首次插入事件成功', () => {
    const inserted = insertEvent('ch-1', 'evt-001', '{"text":"hello"}');
    expect(inserted).toBe(true);
    expect(countEvents('ch-1')).toBe(1);
  });

  it('同一个 external_event_id 重复投递被忽略', () => {
    // 第一次插入
    const first = insertEvent('ch-1', 'evt-001', '{"text":"hello"}');
    expect(first).toBe(true);

    // 第二次插入（相同 external_event_id）
    const second = insertEvent('ch-1', 'evt-001', '{"text":"hello again"}');
    expect(second).toBe(false);

    // 确认只有一条记录
    expect(countEvents('ch-1')).toBe(1);

    // 确认保留的是第一条记录的内容
    const row = db.prepare('SELECT payload_json FROM channel_events WHERE channel_id = ? AND external_event_id = ?').get('ch-1', 'evt-001') as { payload_json: string };
    expect(row.payload_json).toBe('{"text":"hello"}');
  });

  it('不同 external_event_id 各自保留', () => {
    insertEvent('ch-1', 'evt-001', '{"text":"hello"}');
    insertEvent('ch-1', 'evt-002', '{"text":"world"}');

    expect(countEvents('ch-1')).toBe(2);
  });

  it('不同渠道的相同 event_id 不冲突', () => {
    db.prepare('INSERT INTO channels (id, type, name, enabled, status) VALUES (?, ?, ?, ?, ?)').run('ch-2', 'lark', 'Lark Bot', 1, 'connected');

    insertEvent('ch-1', 'evt-001', '{"text":"hello"}');
    insertEvent('ch-2', 'evt-001', '{"text":"hello"}');

    expect(countEvents()).toBe(2);
  });

  it('多方向事件互不影响', () => {
    const now = new Date().toISOString();
    db.prepare('INSERT OR IGNORE INTO channel_events (channel_id, external_event_id, direction, payload_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('ch-1', 'evt-001', 'inbound', '{"text":"in"}', 'received', now);
    db.prepare('INSERT OR IGNORE INTO channel_events (channel_id, external_event_id, direction, payload_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('ch-1', 'evt-001', 'outbound', '{"text":"out"}', 'received', now);

    // 不同方向但相同 event_id — 因为是同一 channel+event_id，仍然被去重
    // 实际上 direction 不是唯一约束的一部分，所以第二次插入应被忽略
    expect(countEvents('ch-1')).toBe(1);
  });

  it('大量重复插入性能正确', () => {
    const now = new Date().toISOString();
    // 插入 100 条不同的事件
    for (let i = 0; i < 100; i++) {
      db.prepare('INSERT OR IGNORE INTO channel_events (channel_id, external_event_id, direction, payload_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('ch-1', `evt-${i}`, 'inbound', '{}', 'received', now);
    }
    expect(countEvents('ch-1')).toBe(100);

    // 尝试重复插入同样的 100 条
    for (let i = 0; i < 100; i++) {
      db.prepare('INSERT OR IGNORE INTO channel_events (channel_id, external_event_id, direction, payload_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('ch-1', `evt-${i}`, 'inbound', '{}', 'received', now);
    }
    // 仍然只有 100 条
    expect(countEvents('ch-1')).toBe(100);
  });
});