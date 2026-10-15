const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ensureWorkspace } = require('./local-workspace.cjs');
const capabilities = ['local_ppt_doctor', 'local_ppt_theme_list', 'local_ppt_dsl_validate', 'local_ppt_build', 'local_ppt_inspect', 'local_ppt_render'];
const mimes = { '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pdf': 'application/pdf', '.png': 'image/png', '.json': 'application/json' };
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
async function listSlidepThemes(query, limit) {
  const status = await slidepStatus();
  if (!status.available) return { ...status, themes: [] };
  const dir = path.join(slidepDirectory(), 'resources', 'themes');
  const names = (await fs.readdir(dir)).filter(name => name.toLowerCase().endsWith('.design.md')).sort((a, b) => a.localeCompare(b));
  const needle = String(query || '').trim().toLowerCase();
  const themes = [];
  for (const fileName of names) {
    const source = await fs.readFile(path.join(dir, fileName), 'utf8');
    const theme = parseThemeDocument(fileName, source);
    if (!needle || `${theme.id} ${theme.name} ${theme.description}`.toLowerCase().includes(needle)) themes.push(theme);
    if (themes.length >= limit) break;
  }
  return { ...status, themes, total: themes.length, query: query || null };
}
async function nodeExecutable() { return process.env.KLA_SLIDEP_NODE || 'node'; }
function parseJsonOutput(output) {
  const lines = String(output || '').trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch { /* slidep may emit converter logs before its JSON result. */ }
  }
  throw new Error('slidep 返回无效结果');
}
async function validateSlidepDsl(source, fileName, workspace, signal, command) {
  const status = await slidepStatus();
  if (!status.available) return { available: false, ok: false, diagnostics: [{ severity: 'error', message: status.reason }] };
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dslFile = path.join(workspace.work, safeName);
  const blank = path.join(workspace.work, 'slidep-blank.pptx');
  await fs.writeFile(dslFile, source, 'utf8');
  await fs.copyFile(path.join(slidepDirectory(), 'resources', 'pptx', 'blank.pptx'), blank);
  signal.throwIfAborted();
  let proc;
  const previousNodePath = process.env.NODE_PATH;
  process.env.NODE_PATH = path.join(slidepDirectory(), 'node_modules');
  try { proc = await command(await nodeExecutable(), [slidepEngine(), 'lint', blank, '--dsl-file', dslFile], workspace.work, 120000, signal); }
  catch (error) { return { available: true, ok: false, diagnostics: [{ severity: 'error', message: error.message }] }; }
  finally { if (previousNodePath === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = previousNodePath; }
  if (proc.exitCode !== 0) return { available: true, ok: false, diagnostics: [{ severity: 'error', message: (proc.stderr || proc.stdout).slice(-2000) }], exitCode: proc.exitCode };
  try { return { available: true, ...parseJsonOutput(proc.stdout) }; }
  catch (error) { return { available: true, ok: false, diagnostics: [{ severity: 'error', message: `${error.message}: ${(proc.stderr || proc.stdout).slice(-1000)}` }] }; }
}
async function executePpt(call, root, signal, approved, helpers) {
  const { command, absolute, filename, within, approvedReadPath } = helpers;
  const workspace = await ensureWorkspace(root, call);
  const folder = workspace.output;
  const args = call.arguments;
  const action = call.tool.replace('local_ppt_', '');
  const request = { action, output: folder };
  if (action === 'theme_list') return { result: await listSlidepThemes(args.query, args.limit || 30) };
  if (action === 'dsl_validate') return { result: await validateSlidepDsl(args.source, args.fileName || 'page.slide', workspace, signal, command) };
  if (action === 'build') {
    if (typeof args.specJson !== 'string' || args.specJson.length > 1_000_000) throw new Error('PPT 语义 JSON 无效或过大');
    request.specJson = args.specJson;
    request.fileName = filename(args.fileName || '演示文稿.pptx');
    if (!request.fileName.toLowerCase().endsWith('.pptx')) throw new Error('成果文件名必须以 .pptx 结尾');
    // Keep the generated file below the Windows MAX_PATH boundary. The
    // per-run workspace intentionally contains several UUIDs, so a natural
    // language file name can otherwise fail only when the engine opens it.
    if (folder.length + 1 + request.fileName.length > 259) {
      request.fileName = `ppt-${String(call.id).replaceAll('-', '').slice(0, 8)}.pptx`;
    }
    request.render = args.render !== false;
  }
  if (action === 'inspect' || action === 'render') {
    if (Boolean(args.path) === Boolean(args.documentId)) throw new Error('请提供 path 或 documentId 中的一个');
    let input;
    if (args.documentId) {
      input = path.resolve(root, args.documentId);
      const real = await fs.realpath(input);
      if (!within(input, root) || !within(real, await fs.realpath(root))) throw new Error('PPT 文档编号不属于当前身份');
    } else input = await approvedReadPath(absolute(args.path), root, approved);
    if (!input.toLowerCase().endsWith('.pptx')) throw new Error('仅支持 PPTX 文件');
    if ((await fs.stat(input)).size > 16 * 1024 * 1024) throw new Error('PPTX 文件限 16 MiB');
    request.input = input;
  }
  signal.throwIfAborted();
  const file = path.join(workspace.work, 'request.json');
  await fs.writeFile(file, JSON.stringify(request), 'utf8');
  let proc;
  try { proc = await command(await pythonExecutable(), ['-X', 'utf8', path.join(kitDirectory(), 'scripts', 'kla_bridge.py'), file], folder, 660000, signal); }
  catch (e) { if (e.code === 'ENOENT') return { result: { error: '未找到 Python，请安装 Python 3.10+ 并运行 scripts/setup-ppt-runtime.ps1' } }; throw e; }
  if (proc.exitCode !== 0) return { result: { error: 'PPT 引擎启动失败：' + proc.stderr.slice(-1000) } };
  let result;
  try { result = JSON.parse(proc.stdout.trim()); } catch { throw new Error('PPT 引擎返回无效结果'); }
  if (action === 'doctor') result.environment = { ...(result.environment || {}), slidep: await slidepStatus() };
  if (result.error) return { result: { ...result, error: result.error.split(folder).join('[任务目录]') } };
  const files = result.files || [];
  delete result.files;
  if (result.documentPath) { result.documentId = path.relative(root, result.documentPath).split(path.sep).join('/'); delete result.documentPath; }
  if (process.env.KLA_LOCAL_ARTIFACT_UPLOAD === 'false') return { result: { ...result, uploaded: false, localOnly: true } };
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
