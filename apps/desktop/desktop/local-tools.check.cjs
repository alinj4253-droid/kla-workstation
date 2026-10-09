const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { executeLocal } = require('./local-tools.cjs');

test('local file skills write, read, and list actual files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kla-local-tools-'));
  const base = { id: randomUUID(), runId: randomUUID(), stepId: randomUUID() };
  try {
    const target = path.join(root, 'result.py');
    const written = await executeLocal({ ...base, tool: 'local_code', arguments: { fileName: 'result.py', path: target, content: 'print(42)\n' } }, root, new AbortController().signal);
    assert.equal(written.result.stored, true);
    assert.equal(written.artifact.fileName, 'result.py');
    assert.equal(await fs.readFile(target, 'utf8'), 'print(42)\n');
    const read = await executeLocal({ ...base, tool: 'local_read', arguments: { path: target } }, root, new AbortController().signal);
    assert.equal(read.result.content, 'print(42)\n');
    const listed = await executeLocal({ ...base, tool: 'local_list', arguments: { path: root } }, root, new AbortController().signal);
    assert.ok(listed.result.entries.some(entry => entry.name === 'result.py'));
    await assert.rejects(executeLocal({ ...base, tool: 'local_write', arguments: { fileName: '../escape.txt', content: 'bad' } }, root, new AbortController().signal), /文件名无效/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('local CLI reports command output and can be cancelled', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kla-local-cli-'));
  const base = { id: randomUUID(), runId: randomUUID(), stepId: randomUUID(), tool: 'local_cli' };
  try {
    const answer = await executeLocal({ ...base, arguments: { executable: process.execPath, args: ['-e', 'process.stdout.write("ready")'] } }, root, new AbortController().signal);
    assert.equal(answer.result.stdout, 'ready');
    const controller = new AbortController();
    const running = executeLocal({ ...base, arguments: { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 10000 } }, root, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(running, /取消/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
