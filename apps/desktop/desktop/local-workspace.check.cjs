const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ensureWorkspace, cleanupWorkspace } = require('./local-workspace.cjs');

test('workspace cleanup preserves active and unacknowledged runs, including under disk pressure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kla-workspace-test-'));
  try {
    const old = new Date(Date.now() - 48 * 3600000).toISOString();
    const create = async (state, journalState) => {
      const call = { id: randomUUID(), runId: randomUUID(), stepId: randomUUID() };
      const dirs = await ensureWorkspace(root, call);
      await fs.writeFile(path.join(dirs.work, 'intermediate.txt'), 'must survive until run ends');
      await fs.writeFile(path.join(dirs.taskRoot, 'workspace.json'), JSON.stringify({ state, updatedAt: old }));
      if (journalState) {
        await fs.mkdir(path.join(root, 'journals'), { recursive: true });
        await fs.writeFile(path.join(root, 'journals', call.id + '.json'), JSON.stringify({ call, state: journalState, acknowledgedAt: old }));
      }
      return { call, dirs };
    };
    const active = await create('acknowledged', 'acknowledged');
    const unknown = await create('acknowledged', 'acknowledged');
    const unacked = await create('acknowledged', 'receipt');
    const running = await create('running', 'running');
    const terminal = await create('acknowledged', 'acknowledged');
    const discarded = await create('discarded', 'discarded');
    const terminalRunIds = [unacked, running, terminal, discarded].map(item => item.call.runId);
    const result = await cleanupWorkspace(root, { maxBytes: 1, ttlHours: 24, terminalRunIds });
    assert.equal(result.removed, 2);
    for (const item of [active, unknown, unacked, running]) {
      assert.equal(await fs.readFile(path.join(item.dirs.work, 'intermediate.txt'), 'utf8'), 'must survive until run ends');
    }
    for (const item of [terminal, discarded]) await assert.rejects(fs.access(item.dirs.runRoot), { code: 'ENOENT' });
    const corrupt = path.join(root, 'journals', 'corrupt.json');
    await fs.writeFile(corrupt, 'not-json');
    assert.equal((await cleanupWorkspace(root, { maxBytes: 1, terminalRunIds: [active.call.runId] })).removed, 0);
    await assert.rejects(ensureWorkspace(root, { id: 'x', runId: '../escape', stepId: 'x' }), /runId/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
