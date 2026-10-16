const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { zipSync, strToU8, unzipSync, strFromU8 } = require('fflate');
const ExcelJS = require('exceljs');
const { executeLocal } = require('./local-tools.cjs');
const { extractMaterial } = require('./local-business-materials.cjs');

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'kla-business-input-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'identity'), input = path.join(root, 'input');
  await fs.mkdir(input, { recursive: true });
  const runId = randomUUID();
  const call = (tool, args = {}, approved = false, run = runId) => executeLocal({ id: randomUUID(), runId: run,
    stepId: randomUUID(), tool, arguments: args }, root, new AbortController().signal, approved);
  const source = path.join(input, '经营原件.csv');
  await fs.writeFile(source, '业务主体,回顾期,收入目标(万元),实际收入(万元)\n用户企业,2026Q3,100,80');
  return { base, root, input, source, runId, call };
}
const context = { company: '用户企业', period: '回顾2026Q3，规划Q4', objective: '分析收入差距并提出行动建议' };

test('without original materials, all business paths request input and produce no report', async t => {
  const { call } = await fixture(t);
  for (const tool of ['local_business_metrics', 'local_business_goal_decompose', 'local_business_deviation', 'local_business_plan', 'local_business_ppt']) {
    const response = await call(tool);
    assert.equal(response.result.needsInput, true);
    assert.equal(response.artifacts, undefined);
    assert.match(response.result.questions.join(), /原始经营材料/);
  }
  const question = await call('local_business_plan', { inputQuestions: ['请补充与实际值同口径的收入目标。'] });
  assert.deepEqual(question.result.questions, ['请补充与实际值同口径的收入目标。']);
});

test('reads actual source evidence without changing it; source sets cannot cross runs or identities', async t => {
  const { call, source, base } = await fixture(t);
  const original = await fs.readFile(source);
  const read = await call('local_business_metrics', { paths: [source] });
  assert.equal(read.result.status, 'ready');
  assert.match(JSON.stringify(read.result.evidence), /用户企业.*2026Q3.*100.*80/);
  assert.equal(read.result.sources[0].checksum, createHash('sha256').update(original).digest('hex'));
  assert.equal(read.result.sources[0].fileName, '经营原件.csv');
  assert.equal(JSON.stringify(read.result).includes(path.dirname(source)), false);
  assert.deepEqual(await fs.readFile(source), original);
  const again = await call('local_business_metrics', { sourceSetId: read.result.sourceSetId, offset: 1 });
  assert.equal(again.result.evidence[0].id, 'E2');
  const otherRun = await call('local_business_plan', { ...context, sourceSetId: read.result.sourceSetId }, false, randomUUID());
  assert.equal(otherRun.result.needsInput, true);
  const otherRoot = path.join(base, 'other-identity'); await fs.mkdir(otherRoot);
  const otherIdentity = await executeLocal({ id: randomUUID(), stepId: randomUUID(), runId: randomUUID(), tool: 'local_business_plan',
    arguments: { ...context, sourceSetId: read.result.sourceSetId } }, otherRoot, new AbortController().signal);
  assert.equal(otherIdentity.result.needsInput, true);
});

test('requires source approval and rejects missing/empty/generated/sample/partially unreadable materials', async t => {
  const { call, source, base, root, input } = await fixture(t);
  const external = path.join(base, 'outside.csv'); await fs.copyFile(source, external);
  assert.equal((await call('local_business_metrics', { paths: [external] })).result.needsInput, true);
  assert.equal((await call('local_business_metrics', { paths: [external] }, true)).result.status, 'ready');
  const empty = path.join(input, 'empty.txt'); await fs.writeFile(empty, '');
  const missing = path.join(input, 'missing.txt');
  const generated = path.join(root, 'work', 'fake.txt'); await fs.mkdir(path.dirname(generated)); await fs.copyFile(source, generated);
  const sample = path.join(base, 'skills', 'kunlu-business-planner', 'metrics.json'); await fs.mkdir(path.dirname(sample), { recursive: true }); await fs.copyFile(source, sample);
  for (const files of [[missing], [empty], [generated], [sample], [source, missing]]) {
    const response = await call('local_business_metrics', { paths: files }, true);
    assert.equal(response.result.needsInput, true, JSON.stringify(response));
    assert.equal(response.result.sourceSetId, undefined);
    assert.equal(response.artifacts, undefined);
  }
  const nested = path.join(input, 'only-nested', 'nested'); await fs.mkdir(nested, { recursive: true }); await fs.copyFile(source, path.join(nested, 'data.csv'));
  assert.equal((await call('local_business_metrics', { paths: [path.dirname(nested)] })).result.needsInput, true);
});

test('extracts XLSX, DOCX and PPTX with source locations and safe XML limits', async t => {
  const { call, input } = await fixture(t);
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('经营表');
  sheet.addRow(['项目', '目标', '实际']); sheet.addRow(['用户业务收入', 100, 80]); sheet.getCell('D2').value = { formula: 'B2-C2' };
  const xlsx = path.join(input, '经营.xlsx'); await book.xlsx.writeFile(xlsx);
  const xml = text => strToU8(text);
  const docx = zipSync({ 'word/document.xml': xml('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>用户经营材料：收入目标100，实际80</w:t></w:r></w:p></w:body></w:document>') });
  const pptx = zipSync({ 'ppt/slides/slide1.xml': xml('<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>用户经营复盘：实际收入80</a:t></p:sld>') });
  await fs.writeFile(path.join(input, '经营.docx'), docx); await fs.writeFile(path.join(input, '经营.pptx'), pptx);
  const read = await call('local_business_metrics', { paths: [xlsx, path.join(input, '经营.docx'), path.join(input, '经营.pptx')] });
  assert.equal(read.result.status, 'ready', JSON.stringify(read));
  assert.equal(read.result.sources.length, 3);
  assert.match(JSON.stringify(read.result.evidence), /工作表 经营表/);
  assert.match(JSON.stringify(read.result.evidence), /正文段落/);
  assert.match(JSON.stringify(read.result.evidence), /幻灯片 1/);
  assert.match(read.result.warnings.join(), /没有缓存值/);
  const malicious = zipSync({ 'word/document.xml': xml('<!DOCTYPE d [<!ENTITY x "bad">]><document>&x;</document>') });
  await assert.rejects(extractMaterial('bad.docx', malicious, new AbortController().signal), /实体/);
  await assert.rejects(extractMaterial('big.txt', Buffer.alloc(8 * 1024 * 1024 + 1), new AbortController().signal), /8 MiB/);
});

function pdfBytes(text) {
  const stream = text ? 'BT /F1 16 Tf 50 700 Td (User business revenue 80) Tj ET' : 'q Q';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let body = '%PDF-1.4\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(body.length); body += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = body.length;
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}
test('PDF without a readable text layer requests OCR instead of inventing numbers', async t => {
  const { call, input } = await fixture(t);
  const text = await extractMaterial('text.pdf', pdfBytes(true), new AbortController().signal);
  assert.match(text.chunks[0].text, /revenue 80/); assert.match(text.chunks[0].location, /PDF 第 1 页/);
  const scan = path.join(input, 'scan.pdf'); await fs.writeFile(scan, pdfBytes(false));
  const response = await call('local_business_metrics', { paths: [scan] });
  assert.equal(response.result.needsInput, true); assert.match(JSON.stringify(response.result.issues), /OCR/);
});

test('only sourced analysis can generate a quality-checked editable PPT through the new builder', async t => {
  const { call, source } = await fixture(t);
  const sourceSetId = (await call('local_business_metrics', { paths: [source] })).result.sourceSetId;
  const missing = await call('local_business_plan', { sourceSetId }); assert.equal(missing.result.questions.length, 3);
  const planned = await call('local_business_plan', { sourceSetId, ...context });
  assert.equal(planned.result.status, 'analysis_context'); assert.equal(planned.artifacts, undefined);
  const storyMarkdown = '# 叙事稿\n受众：用户企业。目标：基于原始经营材料说明真实收入偏差。';
  const designMarkdown = '# 设计稿\n画布1280×720，白底蓝字，标题40，正文24，充分留白。';
  const slides = [{ pageNumber: 1, source: "<Slide style={{width:1280,height:720,background:'#ffffff',padding:60}}><Text style={{fontSize:40,height:70,color:'#183153'}}>用户企业经营分析</Text><Text style={{fontSize:24,height:80,color:'#183153'}}>Q3目标100万元，实际80万元，差额20万元。[E2]</Text></Slide>" }];
  const args = { sourceSetId, ...context, storyMarkdown, designMarkdown, slides, fileName: '用户经营报告.pptx' };
  for (const analysisMarkdown of [undefined, '没有真实证据引用的分析稿，即使包含数字也不能作为报告输入。', '引用不存在的来源[E999]，不能用来生成经营报告。']) {
    const blocked = await call('local_business_ppt', { ...args, analysisMarkdown });
    assert.equal(blocked.result.needsInput, true); assert.equal(blocked.artifacts, undefined);
  }
  const built = await call('local_business_ppt', { ...args, analysisMarkdown: '# 真实经营分析\n原件显示目标100万元、实际80万元[E2]，差额20万元。原因尚需补充证据，不能假定。' });
  assert.equal(built.result.qc?.ok, true, JSON.stringify(built.result));
  assert.equal(built.result.sourceSetId, sourceSetId); assert.deepEqual(built.result.evidenceReferences, ['E2']);
  const pptx = built.artifacts.find(file => file.fileName === args.fileName); assert.ok(pptx);
  const xml = strFromU8(unzipSync(Buffer.from(pptx.content, 'base64'))['ppt/slides/slide1.xml']);
  assert.match([...xml.matchAll(/<a:t>(.*?)<\/a:t>/g)].map(match => match[1]).join(''), /Q3目标100万元/);
});
