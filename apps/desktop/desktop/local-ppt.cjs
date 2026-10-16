const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ensureWorkspace } = require('./local-workspace.cjs');
const slidep = require('./local-ppt-slidep.cjs');
const capabilities = ['local_ppt_doctor', 'local_ppt_guide', 'local_ppt_theme_list', 'local_ppt_dsl_validate', 'local_ppt_build', 'local_ppt_inspect', 'local_ppt_render'];
const mimes = { '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pdf': 'application/pdf', '.png': 'image/png', '.json': 'application/json' };
const guideFiles = {
  workflow: 'references/workflow.md', story: 'references/story-md.md', design: 'references/design-md.md',
  layout: 'references/layout-recipes.md', dsl: 'references/dsl-components.md', lint: 'references/lint-troubleshooting.md',
  themes: 'references/theme-presets.md', theme_library: 'references/theme-library.md',
  environment: 'references/environment.md', portability: 'references/portability.md',
  story_template: 'assets/STORY.template.md',
  design_template: 'assets/DESIGN.template.md', cover_template: 'assets/slide-cover.slide', content_template: 'assets/slide-content.slide',
};
async function pythonExecutable() {
  if (process.env.KLA_PPT_PYTHON) return process.env.KLA_PPT_PYTHON;
  const venv = path.join(process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), '.local'), 'kla-workstation', 'ppt-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  try { await fs.access(venv); return venv; } catch { return process.platform === 'win32' ? 'python.exe' : 'python3'; }
}
function kitDirectory() {
  return process.resourcesPath && !process.defaultApp ? path.join(process.resourcesPath, 'skills', 'deck-agent-kit') : path.join(__dirname, '..', 'resources', 'skills', 'deck-agent-kit');
}
function slidepDirectory() {
  if (process.env.KLA_SLIDEP_DIR) return path.resolve(process.env.KLA_SLIDEP_DIR);
  return path.join(kitDirectory(), 'vendor', 'slidep');
}
function slidepEngine() { return process.env.KLA_SLIDEP_ENGINE || path.join(slidepDirectory(), 'index.cjs'); }
async function slidepStatus() {
  const engine = slidepEngine();
  try {
    await fs.access(engine);
    await fs.access(path.join(slidepDirectory(), 'resources', 'pptx', 'blank.pptx'));
    await fs.access(path.join(slidepDirectory(), 'resources', 'themes'));
    return { available: true, engine: path.basename(engine), node: process.env.KLA_SLIDEP_NODE || 'node' };
  } catch (error) {
    return { available: false, engine: path.basename(engine), reason: error?.code === 'ENOENT' ? '新版 slidep 资源未随桌面端安装' : String(error?.message || error) };
  }
}
function parseThemeDocument(fileName, source) {
  const frontmatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const values = {};
  if (frontmatter) for (const line of frontmatter[1].split(/\r?\n/)) {
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (match) values[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return { id: fileName.replace(/\.DESIGN\.md$/i, ''), fileName, name: values.name || fileName.replace(/\.DESIGN\.md$/i, ''), description: values.description || '', locale: values.locale || undefined };
}
async function listSlidepThemes(query, limit, themeId) {
  const status = await slidepStatus();
  if (!status.available) return { ...status, themes: [] };
  const dir = path.join(slidepDirectory(), 'resources', 'themes');
  const names = (await fs.readdir(dir)).filter(name => name.toLowerCase().endsWith('.design.md')).sort((a, b) => a.localeCompare(b));
  if (themeId) {
    const name = names.find(value => value.replace(/\.DESIGN\.md$/i, '') === themeId);
    if (!name) return { ...status, error: '主题编号不存在', themes: [] };
    const designMarkdown = await fs.readFile(path.join(dir, name), 'utf8');
    return { ...status, theme: parseThemeDocument(name, designMarkdown), designMarkdown: designMarkdown.slice(0, 40_000) };
  }
  const needle = String(query || '').trim().toLowerCase();
  const themes = [];
  for (const fileName of names) {
    const source = await fs.readFile(path.join(dir, fileName), 'utf8');
    const theme = parseThemeDocument(fileName, source);
    if (!needle || `${theme.id} ${theme.name} ${theme.description}`.toLowerCase().includes(needle)) themes.push(theme);
    if (themes.length >= limit) break;
  }
  return { ...status, themes, total: names.length, query: query || null };
}
async function validateSlidepDsl(source, fileName, workspace, signal, command) {
  const status = await slidepStatus();
  if (!status.available) return { available: false, ok: false, diagnostics: [{ severity: 'error', message: status.reason }] };
  const safeName = path.basename(fileName.replace(/[^a-zA-Z0-9._-]/g, '_'));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.slide$/i.test(safeName)) {
    return { available: true, ok: false, diagnostics: [{ severity: 'error', message: 'DSL 文件名必须为英文数字开头的 .slide 文件' }] };
  }
  const dslFile = path.join(workspace.work, safeName);
  const blank = path.join(workspace.work, 'slidep-blank.pptx');
  await fs.writeFile(dslFile, source, 'utf8');
  await fs.copyFile(path.join(slidepDirectory(), 'resources', 'pptx', 'blank.pptx'), blank);
  signal.throwIfAborted();
  try { return { available: true, ...await slidep.lint(slidepEngine(), blank, dslFile, workspace.work, signal, command) }; }
  catch (error) { return { available: true, ok: false, diagnostics: [{ severity: 'error', message: error.message }] }; }
}
async function runPython(action, input, workspace, signal, command) {
  const file = path.join(workspace.work, `${action}-request.json`);
  await fs.writeFile(file, JSON.stringify({ action, output: workspace.output, ...input }), 'utf8');
  const proc = await command(await pythonExecutable(), ['-X', 'utf8', path.join(kitDirectory(), 'scripts', 'kla_bridge.py'), file], workspace.output, 600000, signal);
  if (proc.exitCode !== 0) throw new Error('PPT 辅助程序启动失败：' + (proc.stderr || proc.stdout).slice(-1000));
  try { return JSON.parse(proc.stdout.trim()); } catch { throw new Error('PPT 辅助程序返回无效结果'); }
}
async function executePpt(call, root, signal, approved, helpers) {
  const { command, absolute, within, approvedReadPath } = helpers;
  const workspace = await ensureWorkspace(root, call);
  const folder = workspace.output;
  const args = call.arguments || {};
  const action = call.tool.replace('local_ppt_', '');
  if (action === 'guide') {
    const file = guideFiles[args.section];
    if (!file) return { result: { error: '未知 PPT 制作指南章节' } };
    const content = await fs.readFile(path.join(slidep.resourceDirectory(), file), 'utf8');
    return { result: { section: args.section, content: content.slice(0, 35000), truncated: content.length > 35000 } };
  }
  if (action === 'theme_list') return { result: await listSlidepThemes(args.query, args.limit || 30, args.themeId) };
  if (action === 'dsl_validate') return { result: await validateSlidepDsl(args.source, args.fileName || 'page.slide', workspace, signal, command) };
  let result;
  let files = [];
  if (action === 'build') {
    const status = await slidepStatus();
    if (!status.available) return { result: { error: status.reason } };
    const built = await slidep.build(args, root, call, workspace, signal, approved, helpers, slidepEngine());
    result = built.result;
    files = built.files || [];
    if (built.deck && args.render === true) {
      try {
        const rendered = await runPython('render', { input: built.deck }, workspace, signal, command);
        if (rendered.error) throw new Error(rendered.error);
        if (rendered.pageCount !== result.pageCount) throw new Error('真实渲染页数与 PPTX 页数不一致');
        files.push(...(rendered.files || []));
        result.renderStatus = rendered.renderStatus;
      } catch (error) {
        result.renderStatus = 'unavailable';
        result.warning = `PPTX 已生成并通过布局校验，但辅助 PDF 渲染不可用：${error.message}`;
      }
    }
  } else if (action === 'doctor') {
    const status = await slidepStatus();
    let writing = false;
    if (status.available) {
      try {
        const { writeDeck } = require('./local-ppt-writer.cjs');
        const source = "<Slide style={{width:1280,height:720,background:'#FFFFFF'}}><Text style={{fontSize:28,height:60,color:'#183153'}}>环境检查</Text></Slide>";
        const slides = path.join(workspace.output, 'slides');
        await fs.mkdir(slides, { recursive: true });
        const page = path.join(slides, '01.slide');
        await fs.writeFile(page, source, 'utf8');
        const blank = path.join(workspace.work, 'slidep-blank.pptx');
        await fs.copyFile(path.join(slidepDirectory(), 'resources', 'pptx', 'blank.pptx'), blank);
        const checked = await slidep.lint(slidepEngine(), blank, page, workspace.output, signal, command);
        if (!checked.ok) throw new Error(checked.diagnostics?.[0]?.message || 'slidep lint 未通过');
        await writeDeck({ pages: [{ pageNumber: 1 }], deck: path.join(workspace.output, 'doctor.pptx'),
          output: workspace.output, engine: slidepEngine(), command, signal, nodeRuntime: slidep.nodeRuntime(),
          runner: path.join(__dirname, 'local-ppt-layout-runner.cjs') });
        status.writer = { available: true, kind: 'native-pptx', editorServiceRequired: false, smokeTested: true };
        writing = true;
      } catch (error) { status.writer = { available: false, reason: error.message }; status.reason = `本地 PPT 写入自检失败：${error.message}`; }
    }
    let auxiliary;
    try { auxiliary = (await runPython('doctor', {}, workspace, signal, command)).environment; }
    catch (error) { auxiliary = { available: false, reason: error.message }; }
    return { result: { environment: {
      level: !writing ? 'blocked' : auxiliary?.capabilities?.render ? 'full' : 'partial',
      capabilities: { generate: writing, qc: writing, render: Boolean(auxiliary?.capabilities?.render), inspect: Boolean(auxiliary?.capabilities?.inspect) },
      slidep: status, auxiliary, workflow: slidep.FORMAT,
    } } };
  } else if (action === 'inspect' || action === 'render') {
    if (Boolean(args.path) === Boolean(args.documentId)) throw new Error('请提供 path 或 documentId 中的一个');
    let input;
    if (args.documentId) {
      input = path.resolve(root, args.documentId);
      const real = await fs.realpath(input);
      if (!within(input, root) || !within(real, await fs.realpath(root))) throw new Error('PPT 文档编号不属于当前身份');
    } else input = await approvedReadPath(absolute(args.path), root, approved);
    if (!input.toLowerCase().endsWith('.pptx')) throw new Error('仅支持 PPTX 文件');
    if ((await fs.stat(input)).size > 16 * 1024 * 1024) throw new Error('PPTX 文件限 16 MiB');
    try { result = await runPython(action, { input }, workspace, signal, command); }
    catch (error) { return { result: { error: `PPT ${action === 'inspect' ? '读取' : '渲染'}依赖不可用：${error.message}` } }; }
    files = result.files || [];
    delete result.files;
  } else {
    throw new Error('未知 PPT 操作');
  }
  signal.throwIfAborted();
  if (result.error) return { result: { ...result, error: result.error.split(folder).join('[任务目录]') } };
  if (process.env.KLA_LOCAL_ARTIFACT_UPLOAD === 'false') return { result: { ...result, uploaded: false, ...(files.length ? { localOnly: true } : {}) } };
  const artifacts = [];
  let total = 0;
  for (const output of files) {
    if (!within(await fs.realpath(output), await fs.realpath(folder))) throw new Error('PPT 引擎成果路径越界');
    const stat = await fs.stat(output); total += stat.size;
    if (stat.size > 16 * 1024 * 1024 || total > 32 * 1024 * 1024) throw new Error('PPT 成果超过上传限制，文件已保留在本地任务目录');
    const bytes = await fs.readFile(output);
    const mimeType = mimes[path.extname(output).toLowerCase()];
    if (!mimeType) throw new Error('不支持的 PPT 成果类型');
    const text = mimeType === 'application/json';
    artifacts.push({ fileName: path.basename(output), content: bytes.toString(text ? 'utf8' : 'base64'), contentEncoding: text ? 'utf8' : 'base64', mimeType, checksum: createHash('sha256').update(bytes).digest('hex') });
  }
  return { result: { ...result, uploaded: artifacts.length > 0, files: artifacts.map(a => ({ fileName: a.fileName, mimeType: a.mimeType, checksum: a.checksum })) }, ...(artifacts.length ? { artifacts } : {}) };
}
module.exports = { executePpt, capabilities };
