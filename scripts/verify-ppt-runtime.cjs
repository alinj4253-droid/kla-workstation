// Real, opt-in pptx-deck-builder smoke test. Outputs stay under ignored .runtime/.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { executeLocal } = require('../apps/desktop/desktop/local-tools.cjs');
const JSZip = require(require.resolve('jszip', { paths: [require.resolve('pptxgenjs', { paths: [path.resolve(__dirname, '../apps/desktop')] })] }));

async function main() {
  const root = path.resolve(__dirname, '../.runtime/ppt-smoke');
  const runId = randomUUID();
  const signal = new AbortController().signal;
  await fs.mkdir(root, { recursive: true });
  const invoke = (tool, args) => executeLocal({ id: randomUUID(), runId, stepId: randomUUID(), tool, arguments: args }, root, signal, true);
  const doctor = await invoke('local_ppt_doctor', {});
  assert.equal(doctor.result.environment.capabilities.generate, true, JSON.stringify(doctor.result.environment));
  const storyMarkdown = '# STORY.md\n目标：验证本地 PPT 新流程。受众：项目团队。两页展示基础内容和图表。';
  const designMarkdown = '# DESIGN.md\n画布 1280×720；白底蓝字；标题 40px；正文 24px；图表颜色保持蓝色。';
  const first = `<Slide style={{width:1280,height:720,background:'#FFFFFF',padding:60}}>
    <Text style={{fontSize:40,height:70,color:'#183153'}}>PPT 助手新流程</Text>
    <Text style={{fontSize:24,height:80,color:'#183153'}}>STORY → DESIGN → DSL → lint → PPTX</Text>
  </Slide>`;
  const second = await fs.readFile(path.resolve(__dirname, '../apps/desktop/desktop/fixtures/local-ppt-chart.slide'), 'utf8');
  const built = await invoke('local_ppt_build', { storyMarkdown, designMarkdown, fileName: 'PPT助手验证.pptx',
    slides: [{ pageNumber: 1, source: first }, { pageNumber: 2, source: second }] });
  assert.equal(built.result.qc?.ok, true, JSON.stringify(built.result));
  assert.equal(built.result.pageCount, 2);
  const pptx = built.artifacts.find(file => file.fileName === 'PPT助手验证.pptx');
  assert.ok(pptx);
  for (const file of built.artifacts) {
    const bytes = Buffer.from(file.content, file.contentEncoding === 'base64' ? 'base64' : 'utf8');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.checksum);
  }
  const zip = await JSZip.loadAsync(Buffer.from(pptx.content, 'base64'));
  const slideXml = await zip.file('ppt/slides/slide1.xml').async('string');
  assert.match(slideXml, /<a:t>PPT <\/a:t>/);
  assert.match(slideXml, /<a:t>助手新流程<\/a:t>/);
  assert.ok(Object.keys(zip.files).some(name => /^ppt\/charts\/chart\d+\.xml$/.test(name)));
  const legacy = await invoke('local_ppt_build', { specJson: '{}' });
  assert.match(legacy.result.error, /旧版语义 JSON 流程已停用/);
  await assert.rejects(invoke('local_ppt_inspect', { documentId: '../../package.json' }), /不属于当前身份/);
  console.log(JSON.stringify({ ok: true, workflow: 'pptx-deck-builder/v1', pageCount: built.result.pageCount,
    nativeObjectCount: built.result.qc.nativeObjectCount, renderStatus: built.result.renderStatus,
    documentId: built.result.documentId, files: built.result.files }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
