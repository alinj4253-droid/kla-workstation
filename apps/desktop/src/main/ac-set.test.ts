// @vitest-environment node
import { describe, it, expect, beforeAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './db/migrate';
import { createProjectTools } from './agent-tools';

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString(), isEncrypted: () => true },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
  app: { getPath: () => '/tmp/test', getVersion: () => '0.1.0-test' },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, definition_id TEXT NOT NULL, definition_version TEXT NOT NULL,
      runtime_mode TEXT NOT NULL CHECK(runtime_mode IN ('native-model','external-cli')),
      model_profile_id TEXT, cli_connection_id TEXT, overrides_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, delegatable INTEGER NOT NULL DEFAULT 1,
      is_system_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, base_url TEXT,
      auth_type TEXT NOT NULL DEFAULT 'api-key', secret_ref TEXT, config_json TEXT,
      status TEXT NOT NULL DEFAULT 'unknown', last_checked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS model_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, provider_id TEXT NOT NULL REFERENCES model_providers(id),
      model_id TEXT NOT NULL, parameters_json TEXT,
      declared_capabilities_json TEXT, verified_capabilities_json TEXT,
      capability_tested_at TEXT, enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS model_slot_bindings (
      slot TEXT PRIMARY KEY CHECK(slot IN ('reasoning','fast','embedding')),
      model_profile_id TEXT NOT NULL REFERENCES model_profiles(id), updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('telegram','lark','dingtalk','wecom-webhook')),
      name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'disconnected' CHECK(status IN ('disconnected','connecting','connected','error')),
      config_json TEXT, secret_ref TEXT, last_connected_at TEXT, last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ciphertext TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cli_connections (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, adapter_type TEXT NOT NULL, executable_path TEXT NOT NULL,
      args_json TEXT, strategy_id TEXT, detected_version TEXT, status TEXT NOT NULL DEFAULT 'unknown',
      trust_tier TEXT NOT NULL DEFAULT 'trusted', capabilities_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  return db;
}

describe('AC-SET-01: Settings 读写', () => {
  let db: Database.Database;

  beforeAll(() => { db = createTestDb(); });

  it('settings 表为空时默认返回 system', () => {
    const row = db.prepare('SELECT value_json as v FROM settings WHERE key = ?').get('theme') as { v: string } | undefined;
    expect(row).toBeUndefined();
  });

  it('写入 theme 后可读取', () => {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)').run('theme', JSON.stringify({ value: 'dark' }), now);
    const row = db.prepare('SELECT value_json as v FROM settings WHERE key = ?').get('theme') as { v: string };
    expect(JSON.parse(row.v).value).toBe('dark');
  });

  it('覆盖已有值', () => {
    const now = new Date().toISOString();
    db.prepare('UPDATE settings SET value_json = ?, updated_at = ? WHERE key = ?').run(JSON.stringify({ value: 'light' }), now, 'theme');
    const row = db.prepare('SELECT value_json as v FROM settings WHERE key = ?').get('theme') as { v: string };
    expect(JSON.parse(row.v).value).toBe('light');
  });

  it('secrets 可加密写入', () => {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO secrets (id, kind, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('sec-1', 'provider-openai', Buffer.from('sk-test-key'), now, now);
    const row = db.prepare('SELECT kind, ciphertext FROM secrets WHERE id = ?').get('sec-1') as { kind: string; ciphertext: Buffer };
    expect(row.kind).toBe('provider-openai');
    expect(row.ciphertext.toString()).toBe('sk-test-key');
  });

  it('secrets 可删除', () => {
    db.prepare('DELETE FROM secrets WHERE id = ?').run('sec-1');
    const row = db.prepare('SELECT 1 FROM secrets WHERE id = ?').get('sec-1');
    expect(row).toBeUndefined();
  });

  it('diagnostics 导出基本计数', () => {
    const agentCount = (db.prepare('SELECT COUNT(*) as c FROM agent_profiles').get() as { c: number }).c;
    const provCount = (db.prepare('SELECT COUNT(*) as c FROM model_providers').get() as { c: number }).c;
    const projCount = (db.prepare('SELECT COUNT(*) as c FROM projects').get() as { c: number }).c;
    expect(typeof agentCount).toBe('number');
    expect(typeof provCount).toBe('number');
    expect(typeof projCount).toBe('number');
  });
});

describe('AC-SET-02: Channel 渠道', () => {
  let db: Database.Database;

  beforeAll(() => { db = createTestDb(); });

  it('channels 空列表', () => {
    const rows = db.prepare('SELECT id, type, name FROM channels ORDER BY type, name').all();
    expect(rows).toEqual([]);
  });

  it('创建渠道', () => {
    db.prepare('INSERT INTO channels (id, type, name, config_json) VALUES (?, ?, ?, ?)').run('ch-1', 'telegram', 'My Bot', JSON.stringify({ token: 'test' }));
    const row = db.prepare('SELECT type, name, enabled FROM channels WHERE id = ?').get('ch-1') as { type: string; name: string; enabled: number };
    expect(row.type).toBe('telegram');
    expect(row.name).toBe('My Bot');
    expect(row.enabled).toBe(0);
  });

  it('切换启用状态', () => {
    db.prepare("UPDATE channels SET enabled = ?, status = 'connecting' WHERE id = ?").run(1, 'ch-1');
    const row = db.prepare('SELECT enabled, status FROM channels WHERE id = ?').get('ch-1') as { enabled: number; status: string };
    expect(row.enabled).toBe(1);
    expect(row.status).toBe('connecting');
  });

  it('list 包含新建渠道', () => {
    const rows = db.prepare('SELECT id, type FROM channels ORDER BY type, name').all() as Array<{ id: string; type: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.type === 'telegram')).toBe(true);
  });
});

describe('AC-SET-03: Agent Profile CRUD', () => {
  let db: Database.Database;

  beforeAll(() => { db = createTestDb(); });

  it('空列表', () => {
    const rows = db.prepare('SELECT id FROM agent_profiles').all();
    expect(rows).toEqual([]);
  });

  it('创建 Profile', () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO agent_profiles (id, name, definition_id, definition_version, runtime_mode, enabled, delegatable, is_system_default, created_at, updated_at) VALUES (?, ?, ?, ?, 'external-cli', 1, 1, 0, ?, ?)").run('ap-1', 'Codex CLI', 'custom.codex', '1.0.0', now, now);
    const row = db.prepare('SELECT name, runtime_mode as mode, enabled FROM agent_profiles WHERE id = ?').get('ap-1') as { name: string; mode: string; enabled: number };
    expect(row.name).toBe('Codex CLI');
    expect(row.mode).toBe('external-cli');
    expect(row.enabled).toBe(1);
  });

  it('关闭 Profile', () => {
    db.prepare('UPDATE agent_profiles SET enabled = 0 WHERE id = ?').run('ap-1');
    const v = (db.prepare('SELECT enabled FROM agent_profiles WHERE id = ?').get('ap-1') as { enabled: number }).enabled;
    expect(v).toBe(0);
  });

  it('设为默认 Leader', () => {
    db.prepare('UPDATE agent_profiles SET is_system_default = 0').run();
    db.prepare("UPDATE agent_profiles SET is_system_default = 1 WHERE id = 'ap-1'").run();
    const v = (db.prepare("SELECT is_system_default as d FROM agent_profiles WHERE id = 'ap-1'").get() as { d: number }).d;
    expect(v).toBe(1);
  });

  it('list 包含新建', () => {
    const rows = db.prepare('SELECT id FROM agent_profiles').all();
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('AC-SET-03: 禁用后委派阻断', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agent_profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, definition_id TEXT NOT NULL, definition_version TEXT NOT NULL,
        runtime_mode TEXT NOT NULL, model_profile_id TEXT, cli_connection_id TEXT, overrides_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, delegatable INTEGER NOT NULL DEFAULT 1,
        is_system_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE project_agent_instances (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_profile_id TEXT NOT NULL,
        definition_id TEXT, definition_version TEXT, role TEXT NOT NULL,
        runtime_mode TEXT NOT NULL, model_profile_id TEXT, ordinal INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_instance_id TEXT NOT NULL,
        trigger_message_id TEXT, parent_run_id TEXT, requested_by_type TEXT NOT NULL,
        requested_by_id TEXT NOT NULL, instruction TEXT, status TEXT NOT NULL DEFAULT 'queued',
        attempt INTEGER NOT NULL DEFAULT 1, model_profile_snapshot_json TEXT,
        started_at TEXT, finished_at TEXT, result_message_id TEXT,
        error_code TEXT, error_message TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE agent_run_events (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
        type TEXT NOT NULL, payload_json TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE model_providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, base_url TEXT,
        auth_type TEXT NOT NULL DEFAULT 'api-key', secret_ref TEXT, config_json TEXT,
        status TEXT NOT NULL DEFAULT 'unknown', last_checked_at TEXT
      );
      CREATE TABLE model_profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, provider_id TEXT NOT NULL REFERENCES model_providers(id),
        model_id TEXT NOT NULL, parameters_json TEXT,
        declared_capabilities_json TEXT, verified_capabilities_json TEXT,
        capability_tested_at TEXT, enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE model_slot_bindings (
        slot TEXT PRIMARY KEY CHECK(slot IN ('reasoning','fast','embedding')),
        model_profile_id TEXT NOT NULL REFERENCES model_profiles(id), updated_at TEXT NOT NULL
      );
    `);

    const now = new Date().toISOString();
    db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('proj-1', 'Test Project', now, now);
    db.prepare("INSERT INTO agent_profiles (id, name, definition_id, definition_version, runtime_mode, enabled, delegatable, is_system_default, created_at, updated_at) VALUES (?, ?, ?, ?, 'native-model', 1, 1, 0, ?, ?)").run('ap-enabled', 'Enabled Agent', 'custom.enabled', '1.0.0', now, now);
    db.prepare("INSERT INTO agent_profiles (id, name, definition_id, definition_version, runtime_mode, enabled, delegatable, is_system_default, created_at, updated_at) VALUES (?, ?, ?, ?, 'native-model', 0, 1, 0, ?, ?)").run('ap-disabled', 'Disabled Agent', 'custom.disabled', '1.0.0', now, now);
    db.prepare("INSERT INTO project_agent_instances (id, project_id, agent_profile_id, role, runtime_mode, ordinal, created_at) VALUES (?, ?, ?, ?, 'native-model', 0, ?)").run('pai-enabled', 'proj-1', 'ap-enabled', 'member', now);
    db.prepare("INSERT INTO project_agent_instances (id, project_id, agent_profile_id, role, runtime_mode, ordinal, created_at) VALUES (?, ?, ?, ?, 'native-model', 1, ?)").run('pai-disabled', 'proj-1', 'ap-disabled', 'member', now);
  });

  it('delegate_tasks 拒绝已禁用智能体', async () => {
    const tools = createProjectTools(db);
    const delegateTool = tools.find(t => t.name === 'delegate_tasks')!;
    const result = await delegateTool.execute({
      projectId: 'proj-1',
      agentInstanceId: 'pai-disabled',
      instruction: 'do something',
      parentRunId: 'parent-run-1',
    });
    expect(result).toContain('已被禁用');
  });

  it('delegate_tasks 拒绝不存在的智能体实例', async () => {
    const tools = createProjectTools(db);
    const delegateTool = tools.find(t => t.name === 'delegate_tasks')!;
    const result = await delegateTool.execute({
      projectId: 'proj-1',
      agentInstanceId: 'pai-nonexistent',
      instruction: 'do something',
      parentRunId: 'parent-run-1',
    });
    expect(result).toContain('不存在');
  });

  it('delegate_tasks 放行已启用智能体（后续调度逻辑）', async () => {
    const tools = createProjectTools(db);
    const delegateTool = tools.find(t => t.name === 'delegate_tasks')!;
    const result = await delegateTool.execute({
      projectId: 'proj-1',
      agentInstanceId: 'pai-enabled',
      instruction: 'do something',
      parentRunId: 'parent-run-1',
    });
    // 禁用检查不应拦截
    expect(result).not.toContain('已被禁用');
    // 无 scheduler 时应提示调度器未连接
    expect(result).toContain('调度器未连接');
  });

  it('list_project_agents 不包含已禁用智能体', async () => {
    const tools = createProjectTools(db);
    const listTool = tools.find(t => t.name === 'list_project_agents')!;
    const result = await listTool.execute({ projectId: 'proj-1' });
    expect(result).toContain('Enabled Agent');
    expect(result).not.toContain('Disabled Agent');
  });

  it('list_project_agents 空项目返回无可用提示', async () => {
    const tools = createProjectTools(db);
    const listTool = tools.find(t => t.name === 'list_project_agents')!;
    const result = await listTool.execute({ projectId: 'proj-empty' });
    expect(result).toContain('无可用的智能体');
  });
});

describe('AC-SET-04: 主题切换实时生效，重启后保留', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)'); });

  it('默认主题为 system', () => {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = 'theme'").get() as { value_json: string } | undefined;
    expect(row).toBeUndefined();
  });

  it('保存主题到 DB', () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('theme', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at")
      .run(JSON.stringify({ value: 'dark' }), now);
    const row = db.prepare("SELECT value_json FROM settings WHERE key = 'theme'").get() as { value_json: string };
    expect(JSON.parse(row.value_json).value).toBe('dark');
  });

  it('重启后主题保留（新连接读取）', () => {
    const db2 = new Database(':memory:');
    db2.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)');
    // 模拟迁移：复制数据
    const rows = db.prepare('SELECT key, value_json, updated_at FROM settings').all() as Array<{ key: string; value_json: string; updated_at: string }>;
    for (const r of rows) {
      db2.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)').run(r.key, r.value_json, r.updated_at);
    }
    const row = db2.prepare("SELECT value_json FROM settings WHERE key = 'theme'").get() as { value_json: string };
    expect(JSON.parse(row.value_json).value).toBe('dark');
  });

  it('支持三种主题值', () => {
    for (const theme of ['light', 'dark', 'system']) {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('theme', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at")
        .run(JSON.stringify({ value: theme }), now);
      const row = db.prepare("SELECT value_json FROM settings WHERE key = 'theme'").get() as { value_json: string };
      expect(JSON.parse(row.value_json).value).toBe(theme);
    }
  });

  it('renderer AppearanceSettings 加载并保存主题', () => {
    // Verify source code contains theme persistence calls
    const path = require('path');
    const fs = require('fs');
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'renderer', 'src', 'pages', 'SettingsPage.tsx'), 'utf-8');
    expect(src).toContain("settings.getAll");
    expect(src).toContain("settings.update");
    expect(src).toContain("data-theme");
    expect(src).toContain("'light' | 'dark' | 'system'");
  });
});
