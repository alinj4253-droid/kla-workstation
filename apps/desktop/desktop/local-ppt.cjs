const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ensureWorkspace } = require('./local-workspace.cjs');
const capabilities = ['local_ppt_doctor', 'local_ppt_build', 'local_ppt_inspect', 'local_ppt_render'];
const mimes = { '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pdf': 'application/pdf', '.png': 'image/png', '.json': 'application/json' };
async function pythonExecutable() {
  if (process.env.KLA_PPT_PYTHON) return process.env.KLA_PPT_PYTHON;
  const venv = path.join(process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), '.local'), 'kla-workstation', 'ppt-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  try { await fs.access(venv); return venv; } catch { return process.platform === 'win32' ? 'python.exe' : 'python3'; }
}
function kitDirectory() {
  return process.resourcesPath && !process.defaultApp ? path.join(process.resourcesPath, 'skills', 'deck-agent-kit') : path.join(__dirname, '..', 'resources', 'skills', 'deck-agent-kit');
}
async function executePpt(call, root, signal, approved, helpers) {
  const { command, absolute, filename, within, approvedReadPath } = helpers;
  const workspace = await ensureWorkspace(root, call);
  const folder = workspace.output;
  const args = call.arguments;
  const action = call.tool.replace('local_ppt_', '');
  const request = { action, output: folder };
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
