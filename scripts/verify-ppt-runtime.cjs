// Real, opt-in local engine smoke test. Outputs are kept in ignored .runtime/.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { executeLocal } = require('../apps/desktop/desktop/local-tools.cjs');

async function main() {
  const root = path.resolve(__dirname, '../.runtime/ppt-smoke');
  const runId = randomUUID();
  const signal = new AbortController().signal;
  await fs.mkdir(root, { recursive: true });
  const invoke = (tool, args) => executeLocal({ id: randomUUID(), runId, stepId: 'smoke', tool, arguments: args }, root, signal, true);
  const doctor = await invoke('local_ppt_doctor', {});
  console.log(JSON.stringify({ environment: doctor.result.environment }));
  assert.equal(doctor.result.environment.capabilities.generate, true, 'PPT generation dependencies are missing');
  const specJson = await fs.readFile(path.resolve(__dirname, '../apps/desktop/resources/skills/deck-agent-kit/assets/deck.sample.json'), 'utf8');
  const built = await invoke('local_ppt_build', { specJson, fileName: 'PPT助手验证.pptx', render: true });
  if (built.result.error) throw new Error(JSON.stringify(built.result));
  assert.equal(built.result.qc.ok, true);
  assert.equal(built.result.pageCount, 10);
  assert.equal(built.result.renderStatus, 'completed', 'Real Office rendering is required for this smoke test');
  assert.equal(built.artifacts.length, 5);
  for (const file of built.artifacts) {
    const bytes = Buffer.from(file.content, file.contentEncoding === 'base64' ? 'base64' : 'utf8');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.checksum);
  }
  const inspected = await invoke('local_ppt_inspect', { documentId: built.result.documentId });
  assert.equal(inspected.result.pageCount, 10);
  assert.ok(inspected.result.pages[0].text.includes('客户服务智能化改造'));
  const invalid = await invoke('local_ppt_build', { specJson: JSON.stringify({ ...JSON.parse(specJson), pages: [] }), fileName: 'invalid.pptx' });
  assert.ok(invalid.result.error);
  assert.equal(invalid.artifacts, undefined);
  await assert.rejects(invoke('local_ppt_inspect', { documentId: '../../package.json' }), /不属于当前身份/);
  console.log(JSON.stringify({ ok: true, pageCount: built.result.pageCount, renderStatus: built.result.renderStatus, documentId: built.result.documentId, files: built.result.files, preview: path.join(root, runId, 'smoke') }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
