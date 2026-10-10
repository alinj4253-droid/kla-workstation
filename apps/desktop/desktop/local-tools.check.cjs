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
    assert.equal(written.result.uploaded, true);
    assert.match(written.result.checksum, /^[a-f0-9]{64}$/);
    assert.equal(written.artifact.fileName, 'result.py');
    assert.equal(await fs.readFile(target, 'utf8'), 'print(42)\n');
    const read = await executeLocal({ ...base, tool: 'local_read', arguments: { path: target } }, root, new AbortController().signal);
    assert.equal(read.result.content, 'print(42)\n');
    const writtenText = await executeLocal({ ...base, tool: 'local_write', arguments: { fileName: 'notes.md', content: '# Verified\n' } }, root, new AbortController().signal);
    assert.equal(writtenText.result.stored, true);
    assert.equal(await fs.readFile(path.join(root, 'runs', base.runId, base.stepId, base.id, 'output', 'notes.md'), 'utf8'), '# Verified\n');
    const listed = await executeLocal({ ...base, tool: 'local_list', arguments: { path: root } }, root, new AbortController().signal);
    assert.ok(listed.result.entries.some(entry => entry.name === 'result.py'));
    await assert.rejects(executeLocal({ ...base, tool: 'local_write', arguments: { fileName: '../escape.txt', content: 'bad' } }, root, new AbortController().signal), /文件名无效/);
    await assert.rejects(executeLocal({ ...base, tool: 'local_read', arguments: { path: __filename } }, root, new AbortController().signal), /允许目录/);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'kla-outside-'));
    try {
      const approvedFile = path.join(outside, 'approved.txt');
      await fs.writeFile(approvedFile, 'approved content', 'utf8');
      const readApproved = await executeLocal({ ...base, tool: 'local_read', arguments: { path: approvedFile } }, root, new AbortController().signal, true);
      assert.equal(readApproved.result.content, 'approved content');
      const listApproved = await executeLocal({ ...base, tool: 'local_list', arguments: { path: outside } }, root, new AbortController().signal, true);
      assert.ok(listApproved.result.entries.some(entry => entry.name === 'approved.txt'));
      await assert.rejects(executeLocal({ ...base, tool: 'local_write', arguments: { fileName: 'blocked.txt', path: path.join(outside, 'blocked.txt'), content: 'bad' } }, root, new AbortController().signal, true), /允许目录/);
      await fs.symlink(path.join(outside, 'redirect.py'), path.join(root, 'redirect.py'));
      await assert.rejects(executeLocal({ ...base, tool: 'local_code', arguments: { fileName: 'redirect.py', path: path.join(root, 'redirect.py'), content: 'bad' } }, root, new AbortController().signal), /允许目录|符号链接/);
      const linkedFile = path.join(outside, 'linked.txt');
      await fs.symlink(approvedFile, linkedFile);
      await assert.rejects(executeLocal({ ...base, tool: 'local_read', arguments: { path: linkedFile } }, root, new AbortController().signal, true), /符号链接/);
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
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

test('local BAT executes a command on Windows', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kla-local-bat-'));
  try {
    const call = { id: randomUUID(), runId: randomUUID(), stepId: randomUUID(), tool: 'local_bat', arguments: { script: 'echo KLA_BAT_OK' } };
    const result = await executeLocal(call, root, new AbortController().signal);
    assert.equal(result.result.exitCode, 0);
    assert.match(result.result.stdout, /KLA_BAT_OK/);
    assert.match(result.result.workingDirectory, /^workspace:\/\//);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('shared input downloads into an isolated workspace and CLI output can be explicitly published', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kla-shared-local-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'kla-private-local-'));
  const signal = new AbortController().signal;
  const base = { runId: randomUUID(), stepId: randomUUID() };
  const call = (tool, args) => ({ ...base, id: randomUUID(), tool, arguments: args });
  try {
    const input = Buffer.from('shared source\n');
    const fetched = await executeLocal(call('local_file_fetch', { fileId: randomUUID() }), root, signal, false, async () => ({ name: 'input.txt', bytes: input }));
    assert.match(fetched.result.path, /^workspace:\/\/runs\//);
    const read = await executeLocal(call('local_read', { path: fetched.result.path }), root, signal);
    assert.equal(read.result.content, input.toString());
    const output = await executeLocal(call('local_cli', { executable: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("report.pdf", Buffer.from("%PDF-1.4 test"))'] }), root, signal);
    assert.equal(output.result.exitCode, 0);
    const published = await executeLocal(call('local_file_publish', { path: output.result.workingDirectory + '/report.pdf' }), root, signal);
    assert.equal(published.artifact.mimeType, 'application/pdf');
    assert.equal(published.artifact.contentEncoding, 'base64');
    assert.equal(Buffer.from(published.artifact.content, 'base64').toString(), '%PDF-1.4 test');
    const privatePath = path.join(outside, 'private.txt');
    await fs.writeFile(privatePath, 'private');
    await assert.rejects(executeLocal(call('local_file_publish', { path: privatePath }), root, signal), /允许目录/);
    assert.equal((await executeLocal(call('local_file_publish', { path: privatePath }), root, signal, true)).artifact.content, 'private');
    await assert.rejects(executeLocal(call('local_read', { path: 'workspace://../private.txt' }), root, signal), /越界/);
    await assert.rejects(executeLocal(call('local_file_fetch', { fileId: randomUUID() }), root, signal, false, async () => ({ name: '../escape.txt', bytes: input })), /文件名/);
    const prior = process.env.KLA_LOCAL_ARTIFACT_UPLOAD;
    try {
      process.env.KLA_LOCAL_ARTIFACT_UPLOAD = 'false';
      const localOnly = await executeLocal(call('local_file_publish', { path: fetched.result.path }), root, signal);
      assert.equal(localOnly.result.localOnly, true);
      assert.equal(localOnly.artifact, undefined);
    } finally { if (prior === undefined) delete process.env.KLA_LOCAL_ARTIFACT_UPLOAD; else process.env.KLA_LOCAL_ARTIFACT_UPLOAD = prior; }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
