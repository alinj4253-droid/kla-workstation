const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { executeLocal } = require('./local-tools.cjs');

const python = process.platform === 'win32' ? 'python.exe' : 'python3';
const hasPythonDependencies = spawnSync(python, ['-c', 'import pptx'], { timeout: 10000, windowsHide: true }).status === 0;

test('business planner reads a long-path request and generates a PPTX', { skip: !hasPythonDependencies }, async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kla-planner-long-path-'));
  // Match production: the child process cwd is below MAX_PATH while the
  // request file itself crosses it (the failing case reported by Windows).
  const root = path.join(temporaryRoot, randomUUID(), '1234567');
  const signal = new AbortController().signal;
  const call = (tool, arguments_) => ({ id: randomUUID(), runId: randomUUID(), stepId: randomUUID(), tool, arguments: arguments_ });
  try {
    await fs.mkdir(root, { recursive: true });
    const metricsCall = call('local_business_metrics', {});
    const requestPath = path.join(root, 'runs', metricsCall.runId, metricsCall.stepId, metricsCall.id, 'work', 'business-planner-request.json');
    if (process.platform === 'win32') {
      assert.ok(path.dirname(requestPath).length < 260, 'child process cwd must remain launchable');
      assert.ok(requestPath.length > 260, `test path must exceed MAX_PATH: ${requestPath.length}`);
    }
    const metrics = await executeLocal(metricsCall, root, signal);
    assert.equal(metrics.result.error, undefined);
    assert.equal(metrics.result.kind, 'metrics');
    assert.ok(metrics.result.data);

    const ppt = await executeLocal(call('local_business_ppt', { type: 'company', fileName: '三一规划长路径验证.pptx' }), root, signal);
    assert.equal(ppt.result.error, undefined);
    assert.equal(ppt.result.kind, 'ppt');
    assert.equal(ppt.artifact.fileName, '三一规划长路径验证.pptx');
    assert.equal(Buffer.from(ppt.artifact.content, 'base64').subarray(0, 4).toString('hex'), '504b0304');
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
