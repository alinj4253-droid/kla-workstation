// @vitest-environment node
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planHomeRequest } from './gm-agent';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, definition_id TEXT NOT NULL,
      runtime_mode TEXT NOT NULL, model_profile_id TEXT, overrides_json TEXT,
      cli_connection_id TEXT, enabled INTEGER NOT NULL, is_system_default INTEGER NOT NULL
    );
    CREATE TABLE cli_connections (id TEXT PRIMARY KEY, adapter_type TEXT);
  `);
  const insert = db.prepare(`INSERT INTO agent_profiles
    (id, name, definition_id, runtime_mode, model_profile_id, overrides_json, cli_connection_id, enabled, is_system_default)
    VALUES (?, ?, ?, ?, NULL, NULL, ?, 1, ?)`);
  insert.run('builtin-gm-profile', 'GM智能体', 'builtin.gm', 'native-model', null, 0);
  insert.run('builtin-orchestrator-profile', '统筹管理智能体', 'builtin.orchestrator', 'native-model', null, 1);
  insert.run('builtin-local-executor-profile', '本地执行智能体', 'builtin.local-executor', 'native-model', null, 0);
  insert.run('builtin-knowledge-profile', '知识管理智能体', 'builtin.knowledge-manager', 'native-model', null, 0);
  insert.run('builtin-researcher-profile', '资料调研智能体', 'builtin.researcher', 'native-model', null, 0);
  insert.run('builtin-material-writer-profile', '材料编写智能体', 'builtin.material-writer', 'native-model', null, 0);
  insert.run('builtin-acceptance-reviewer-profile', '验收智能体', 'builtin.acceptance-reviewer', 'native-model', null, 0);
});

afterEach(() => db.close());

describe('GM homepage planning', () => {
  it('uses a minimal local team when no model is configured', async () => {
    const plan = await planHomeRequest(db, null, '根据公司内部制度整理一份来访接待报告，并复核事实');

    expect(plan.source).toBe('fallback');
    expect(plan.requestedAgentProfileIds).toEqual([
      'builtin-orchestrator-profile',
      'builtin-local-executor-profile',
    ]);
    expect(plan.requestedAgentProfileIds).not.toContain('builtin-gm-profile');
  });

  it('keeps a simple question with the orchestrator only', async () => {
    const plan = await planHomeRequest(db, null, '你好，介绍一下你自己');
    expect(plan.requestedAgentProfileIds).toEqual(['builtin-orchestrator-profile']);
  });

  it('adds the local executor for explicit knowledge ingestion work', async () => {
    const plan = await planHomeRequest(db, null, '把刚上传的合同做 OCR、标准化、切片并知识化入库');
    expect(plan.requestedAgentProfileIds).toEqual([
      'builtin-orchestrator-profile',
      'builtin-local-executor-profile',
    ]);
  });
});
