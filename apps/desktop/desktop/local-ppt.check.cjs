const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { executeLocal } = require('./local-tools.cjs');
const JSZip = require(require.resolve('jszip', { paths: [require.resolve('pptxgenjs')] }));

const slide = title => `<Slide style={{width:1280,height:720,background:'#ffffff',padding:60}}>
  <Text style={{fontSize:40,height:70,color:'#183153'}}>${title}</Text>
  <Text style={{fontSize:24,height:80,color:'#183153'}}>这是可编辑的原生文字。</Text>
</Slide>`;
const storyMarkdown = '# 叙事稿\n受众：产品团队。目标：说明新流程。页面：封面与验证页。';
const designMarkdown = '# 设计稿\n画布：1280×720。白底蓝字。标题 40，正文 24。逐页使用稳定留白。';

test('PPT builder uses lint→native PPTX, supports drafts and page replacements without the old semantic JSON', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kla-ppt-tools-'));
  const runId = randomUUID();
  const call = (tool, arguments_) => executeLocal({ id: randomUUID(), runId,
    stepId: randomUUID(), tool, arguments: arguments_ }, root, new AbortController().signal);
  try {
    const doctor = await call('local_ppt_doctor', {});
    assert.equal(doctor.result.environment.capabilities.generate, true, JSON.stringify(doctor.result));
    const guide = await call('local_ppt_guide', { section: 'workflow' });
    assert.match(guide.result.content, /STORY\.md/);
    const themes = await call('local_ppt_theme_list', { limit: 5 });
    assert.ok(themes.result.themes.length > 0);
    const selected = await call('local_ppt_theme_list', { themeId: themes.result.themes[0].id });
    assert.ok(selected.result.designMarkdown);
    const dsl = await call('local_ppt_dsl_validate', { source: slide('预检'), fileName: 'check.slide' });
    assert.equal(dsl.result.ok, true, JSON.stringify(dsl.result));

    const draft = await call('local_ppt_build', { storyMarkdown, designMarkdown,
      slides: [{ pageNumber: 1, source: slide('第一页') }], fileName: 'test.pptx', finalize: false });
    assert.equal(draft.result.qc?.ok, true, JSON.stringify(draft.result));
    assert.equal(draft.result.pageCount, 1);
    assert.equal(draft.result.draft, true);
    assert.equal(draft.artifacts, undefined);

    const built = await call('local_ppt_build', { documentId: draft.result.documentId,
      slides: [{ pageNumber: 2, source: slide('第二页') }], fileName: 'test.pptx' });
    assert.equal(built.result.qc?.ok, true, JSON.stringify(built.result));
    assert.equal(built.result.pageCount, 2);
    assert.equal(built.result.renderStatus, 'not_requested');
    assert.deepEqual(built.artifacts.map(file => file.fileName).sort(), ['deck.qc.json', 'deck.source.json', 'test.pptx']);
    const pptxArtifact = built.artifacts.find(file => file.fileName === 'test.pptx');
    const zip = await JSZip.loadAsync(Buffer.from(pptxArtifact.content, 'base64'));
    assert.match(await zip.file('ppt/slides/slide1.xml').async('string'), /第一页/);
    assert.match(await zip.file('ppt/slides/slide2.xml').async('string'), /第二页/);

    const picture = path.join(root, 'sample.png');
    await fs.writeFile(picture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64'));
    const visualSource = await fs.readFile(path.join(__dirname, 'fixtures', 'local-ppt-visual.slide'), 'utf8');
    const chartSource = await fs.readFile(path.join(__dirname, 'fixtures', 'local-ppt-chart.slide'), 'utf8');
    const lineSource = await fs.readFile(path.join(__dirname, 'fixtures', 'local-ppt-line.slide'), 'utf8');
    const pieSource = await fs.readFile(path.join(__dirname, 'fixtures', 'local-ppt-pie.slide'), 'utf8');
    const visual = await call('local_ppt_build', { storyMarkdown, designMarkdown, fileName: 'visual.pptx',
      assets: [{ sourcePath: picture, fileName: 'sample.png' }],
      slides: [{ pageNumber: 1, source: visualSource }, { pageNumber: 2, source: chartSource },
        { pageNumber: 3, source: lineSource }, { pageNumber: 4, source: pieSource }] });
    assert.equal(visual.result.qc?.ok, true, JSON.stringify(visual.result));
    const visualZip = await JSZip.loadAsync(Buffer.from(visual.artifacts.find(file => file.fileName === 'visual.pptx').content, 'base64'));
    assert.match(await visualZip.file('ppt/slides/slide1.xml').async('string'), /视觉元素测试/);
    assert.match(await visualZip.file('ppt/slides/slide2.xml').async('string'), /可编辑图表测试/);
    assert.ok(Object.keys(visualZip.files).some(name => name.startsWith('ppt/media/')));
    assert.equal(Object.keys(visualZip.files).filter(name => /^ppt\/charts\/chart\d+\.xml$/.test(name)).length, 3);

    await assert.rejects(call('local_ppt_build', { storyMarkdown, designMarkdown, fileName: 'missing.pptx',
      slides: [{ pageNumber: 1, source: visualSource }] }), /未加载的图片素材/);

    const replacement = await call('local_ppt_build', { documentId: built.result.documentId,
      slides: [{ pageNumber: 1, source: slide('第一页修改') }], fileName: 'revised.pptx' });
    assert.equal(replacement.result.pageCount, 2);
    assert.notEqual(replacement.result.documentId, built.result.documentId);
    const oldManifest = JSON.parse((await fs.readFile(path.join(path.dirname(path.resolve(root, built.result.documentId)), 'deck.source.json'), 'utf8')));
    const newManifest = JSON.parse((await fs.readFile(path.join(path.dirname(path.resolve(root, replacement.result.documentId)), 'deck.source.json'), 'utf8')));
    assert.match(oldManifest.slides[0].source, /第一页</);
    assert.match(newManifest.slides[0].source, /第一页修改/);
    assert.match(newManifest.slides[1].source, /第二页/);

    await assert.rejects(call('local_ppt_build', { documentId: built.result.documentId,
      slides: [{ pageNumber: 3, source: 'const secret = (process.env.SECRET); <Slide style={{width:1280,height:720}}><Text style={{fontSize:30,height:60}}>{secret}</Text></Slide>' }] }),
    /不允许的表达式/);
    const legacy = await call('local_ppt_build', { specJson: '{}' });
    assert.match(legacy.result.error, /旧版语义 JSON 流程已停用/);
    await assert.rejects(call('local_ppt_build', { documentId: '../../package.json' }), /不属于当前身份/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, { timeout: 240_000 });
