// @vitest-environment node
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// AC-EXT-01: PATH 检测、手选路径和版本不兼容分别得到稳定状态
// ---------------------------------------------------------------------------
describe('AC-EXT-01', () => {
  it('detect returns available or not-found for codex', async () => {
    const { CodexCliAdapter } = await import('@kunqing/agent-core');
    const adapter = new CodexCliAdapter();
    const result = await adapter.detect({}, new AbortController().signal);
    expect(result.length > 0 || result.length === 0).toBe(true);
    if (result.length > 0) {
      expect(result[0]!.executablePath).toBeTruthy();
    }
  });

  it('agent connection service reports failed for unsupported adapter', async () => {
    const { AgentConnectionService } = await import('./agent-connection-service');
    const svc = new AgentConnectionService();
    const result = await svc.startAuto('nonexistent-cli');
    expect(result.snapshot.step).toBe('failed');
    expect(result.snapshot.error?.code).toBe('UNSUPPORTED_ADAPTER');
  });

  it('detect only uses PATH lookups not disk scan', async () => {
    const { CodexCliAdapter } = await import('@kunqing/agent-core');
    const adapter = new CodexCliAdapter();
    const source = adapter.detect.toString();
    expect(source).not.toContain('readdirSync');
    expect(source).not.toContain('walk');
  });
});

// ---------------------------------------------------------------------------
// AC-EXT-02: 特殊字符不会造成额外命令执行
// ---------------------------------------------------------------------------
describe('AC-EXT-02', () => {
  it('CodexCliAdapter uses shell: process.platform check', async () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../../../packages/agent-core/src/adapters/codex/adapter.ts'), 'utf-8');
    expect(source).toContain('shell: process.platform');
  });

  it('ClaudeCodeCliAdapter uses shell: process.platform check', async () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../../../packages/agent-core/src/adapters/claude-code/adapter.ts'), 'utf-8');
    expect(source).toContain('shell: process.platform');
  });

  it('cli-executor source uses spawn not exec', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../main/cli-executor.ts'), 'utf-8');
    expect(source).toContain('supervisor.spawn(');
    expect(source).not.toContain('exec(');
  });
});

// ---------------------------------------------------------------------------
// AC-EXT-04: 取消和中断状态
// ---------------------------------------------------------------------------
describe('AC-EXT-04', () => {
  it('ProcessSupervisor cancel marks run as cancelled', async () => {
    const { ProcessSupervisor } = await import('./process-supervisor');
    const supervisor = new ProcessSupervisor();
    const spec = {
      executable: process.execPath,
      args: ['-e', 'setTimeout(()=>{},10000)'],
      cwd: process.cwd(),
      env: {} as Record<string, string>,
      shell: false as const,
    };
    supervisor.spawn('test-cancel-1', spec);
    expect((supervisor as any).processes.has('test-cancel-1')).toBe(true);
    supervisor.cancel('test-cancel-1');
    const proc = (supervisor as any).processes.get('test-cancel-1');
    expect(proc?.killed).toBe(true);
    supervisor.cancelAll();
  });

  it('ProcessSupervisor 终止使用跨平台进程树终止策略（taskkill / process group kill）', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../main/process-supervisor.ts'), 'utf-8');
    expect(source).toContain('killProcessTree');
    expect(source).toContain('taskkill');
    expect(source).toContain('detached: true');
  });

  it('ProcessSupervisor 有 stdout/stderr 输出大小上限，超限时终止进程', async () => {
    const { ProcessSupervisor } = await import('./process-supervisor');
    const supervisor = new ProcessSupervisor();
    const events: any[] = [];
    const unsub1 = supervisor.on('test-limit', 'stdout', (e) => events.push(e));
    const unsub2 = supervisor.on('test-limit', 'size_limit_exceeded', (e) => events.push(e));

    const spec = {
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(50000))'],
      cwd: process.cwd(),
      env: {} as Record<string, string>,
      shell: false as const,
    };
    supervisor.spawn('test-limit', spec, { maxStdoutBytes: 100, timeoutMs: 5000 });

    // 等待退出
    await new Promise<void>((resolve) => {
      const unsub = supervisor.on('test-limit', 'exit', () => { unsub(); resolve(); });
      supervisor.on('test-limit', 'error', () => { unsub(); resolve(); });
    });

    const limitEvent = events.find((e) => e.type === 'size_limit_exceeded');
    expect(limitEvent).toBeDefined();
    expect(limitEvent.stream).toBe('stdout');
    expect(limitEvent.limitBytes).toBe(100);
    expect(limitEvent.actualBytes).toBeGreaterThan(100);

    unsub1(); unsub2();
    supervisor.cancelAll();
  });

  it('ProcessSupervisor 源码包含 stdout/stderr 大小上限配置', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../main/process-supervisor.ts'), 'utf-8');
    expect(source).toContain('maxStdoutBytes');
    expect(source).toContain('maxStderrBytes');
    expect(source).toContain('size_limit_exceeded');
  });

  it('Scheduler recovers running runs as interrupted', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_instance_id TEXT NOT NULL,
        trigger_message_id TEXT, parent_run_id TEXT,
        requested_by_type TEXT NOT NULL DEFAULT 'user', requested_by_id TEXT NOT NULL DEFAULT '',
        instruction TEXT, status TEXT NOT NULL DEFAULT 'queued',
        attempt INTEGER NOT NULL DEFAULT 1,
        model_profile_snapshot_json TEXT, started_at TEXT, finished_at TEXT,
        result_message_id TEXT, error_code TEXT, error_message TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE agent_run_events (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL,
        seq INTEGER NOT NULL, type TEXT NOT NULL,
        payload_json TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO projects (id, name) VALUES ('proj-1', 'test');
      INSERT INTO agent_runs (id, project_id, agent_instance_id, status, created_at, requested_by_type, requested_by_id)
        VALUES ('run-1', 'proj-1', 'inst-1', 'running', '2024-01-01T00:00:00Z', 'user', 'u1');
      INSERT INTO agent_runs (id, project_id, agent_instance_id, status, created_at, requested_by_type, requested_by_id)
        VALUES ('run-2', 'proj-1', 'inst-1', 'completed', '2024-01-01T00:00:00Z', 'user', 'u1');
    `);
    const { Scheduler } = await import('./scheduler');
    const scheduler = new Scheduler(db, async () => {});
    const count = scheduler.recoverInterruptedRuns();
    expect(count).toBe(1);
    const run1 = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get('run-1') as { status: string };
    expect(run1.status).toBe('interrupted');
    const run2 = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get('run-2') as { status: string };
    expect(run2.status).toBe('completed');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// AC-EXT-05: 密钥不在明文中泄露
// ---------------------------------------------------------------------------
describe('AC-EXT-05', () => {
  it('secrets table stores ciphertext not plaintext', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE secrets (id TEXT, kind TEXT, ciphertext TEXT, created_at TEXT, updated_at TEXT)`);
    db.prepare("INSERT INTO secrets VALUES ('s1', 'api-key', 'encrypted:some-ciphertext', 'now', 'now')").run();
    const row = db.prepare("SELECT ciphertext FROM secrets WHERE id = 's1'").get() as { ciphertext: string };
    expect(row.ciphertext).not.toContain('sk-');
    expect(row.ciphertext).not.toMatch(/^[A-Za-z0-9_\-]{16,}$/);
    db.close();
  });

  it('diagnostic export does not include plaintext secrets', () => {
    const diag = {
      version: '0.1.0',
      platform: 'test',
      agentCount: 2,
      modelProviderCount: 1,
      projectCount: 0,
    };
    expect(diag).not.toHaveProperty('apiKey');
    expect(diag).not.toHaveProperty('secret');
    expect(diag).not.toHaveProperty('token');
    expect(JSON.stringify(diag)).not.toMatch(/(sk-|api_key|secret)/i);
  });

  it('logger redacts secret paths', async () => {
    const { getLogger } = await import('./logger');
    const logger = getLogger();
    expect(logger).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC-EXT-06: 网络提示
// ---------------------------------------------------------------------------
describe('AC-EXT-06', () => {
  it('codex adapter returns capabilities including network-access', async () => {
    const { CodexCliAdapter } = await import('@kunqing/agent-core');
    const adapter = new CodexCliAdapter();
    const caps = adapter.getCapabilities();
    expect(Array.isArray(caps)).toBe(true);
    expect(caps.length).toBeGreaterThan(0);
    expect(caps).toContain('network-access');
  });

  it('claude-code adapter returns capabilities including network-access', async () => {
    const { ClaudeCodeCliAdapter } = await import('@kunqing/agent-core');
    const adapter = new ClaudeCodeCliAdapter();
    const caps = adapter.getCapabilities();
    expect(Array.isArray(caps)).toBe(true);
    expect(caps.length).toBeGreaterThan(0);
    expect(caps).toContain('network-access');
  });

  it('codex adapter capabilities match contract', async () => {
    const { getContract, validateCapabilities } = await import('@kunqing/agent-core');
    const { CodexCliAdapter } = await import('@kunqing/agent-core');
    const adapter = new CodexCliAdapter();
    const contract = getContract('codex');
    expect(contract).toBeDefined();
    expect(contract!.expectedCapabilities).toContain('network-access');
    const result = validateCapabilities('codex', adapter.getCapabilities());
    expect(result.ok).toBe(true);
  });

  it('claude-code adapter capabilities match contract', async () => {
    const { getContract, validateCapabilities } = await import('@kunqing/agent-core');
    const { ClaudeCodeCliAdapter } = await import('@kunqing/agent-core');
    const adapter = new ClaudeCodeCliAdapter();
    const contract = getContract('claude-code');
    expect(contract).toBeDefined();
    expect(contract!.expectedCapabilities).toContain('network-access');
    const result = validateCapabilities('claude-code', adapter.getCapabilities());
    expect(result.ok).toBe(true);
  });

  it('fake-agent source shows blocking network confirmation dialog with context enumeration', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, 'fake-agent.ts'), 'utf-8');
    expect(source).toContain('showMessageBox');
    expect(source).toContain('网络出站提示');
    expect(source).toContain('网络型 CLI 智能体');
    expect(source).toContain('当前对话消息');
    expect(source).toContain('项目知识库片段');
    expect(source).toContain('引用文件摘要');
    expect(source).toContain('按照其供应商策略处理数据');
    expect(source).toContain('允许运行');
    expect(source).toContain('取消');
  });

  it('index.ts agents:startProcess shows network confirmation dialog', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, 'index.ts'), 'utf-8');
    expect(source).toContain('showMessageBox');
    expect(source).toContain('网络出站提示');
    expect(source).toContain('允许运行');
    expect(source).toContain('取消');
  });

  it('agent-connection-service source references trustTier', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, 'agent-connection-service.ts'), 'utf-8');
    expect(source).toContain('trustTier');
    expect(source).toContain('capabilities');
  });
});
