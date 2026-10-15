const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { executeLocal } = require('./local-tools.cjs');

test('PPT doctor, build, inspect, and render execute through the desktop tool adapter', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kla-ppt-tools-'));
  const runId = randomUUID();
  const call = (tool, arguments_) => executeLocal({ id: randomUUID(), runId,
    stepId: randomUUID(), tool, arguments: arguments_ }, root, new AbortController().signal);
  try {
    const doctor = await call('local_ppt_doctor', {});
    assert.equal(doctor.result.environment.level, 'full');
    const themes = await call('local_ppt_theme_list', { limit: 5 });
    assert.equal(themes.result.available, true, JSON.stringify(themes.result));
    assert.ok(themes.result.themes.length > 0);
    const dsl = await call('local_ppt_dsl_validate', {
      fileName: 'check.slide',
      source: '<Slide style={{width:1280,height:720,background:"#ffffff"}}><Text style={{fontSize:40,height:60}}>布局校验</Text></Slide>',
    });
    assert.equal(dsl.result.available, true, JSON.stringify(dsl.result));
    assert.equal(dsl.result.ok, true, JSON.stringify(dsl.result));
    const spec = { title: '测试演示文稿', design_system: 'modern-tech', pages: [
      { page_id: 'p01', kind: 'cover', page_job: '介绍主题', title: '测试演示文稿',
        meta: ['测试'], blocks: [{ type: 'lead', text: '工具链验证' }] },
      { page_id: 'p02', kind: 'content', page_job: '说明结论', title: '工具链可以生成演示文稿',
        blocks: [{ type: 'card', title: '结果', body: '生成、读取和渲染均可执行。' },
          { type: 'concl', text: '工具链验证完成。' }] },
    ] };
    const build = await call('local_ppt_build', { specJson: JSON.stringify(spec), fileName: 'test.pptx', render: true });
    assert.equal(build.result.qc?.ok, true, JSON.stringify(build.result));
    assert.equal(build.result.renderStatus, 'completed');
    assert.ok(build.result.documentId);
    assert.ok(build.artifacts.some(file => file.fileName === 'test.pptx'));
    const inspect = await call('local_ppt_inspect', { documentId: build.result.documentId });
    assert.equal(inspect.result.pageCount, 2);
    const render = await call('local_ppt_render', { documentId: build.result.documentId });
    assert.equal(render.result.renderStatus, 'completed');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, { timeout: 180_000 });
