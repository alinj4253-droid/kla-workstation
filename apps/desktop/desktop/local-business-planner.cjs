const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ensureWorkspace } = require('./local-workspace.cjs');

const capabilities = ['local_business_metrics', 'local_business_goal_decompose', 'local_business_deviation', 'local_business_plan', 'local_business_ppt'];
const pptMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

async function pythonExecutable() {
  if (process.env.KLA_BUSINESS_PLANNER_PYTHON) return process.env.KLA_BUSINESS_PLANNER_PYTHON;
  if (process.env.KLA_PPT_PYTHON) return process.env.KLA_PPT_PYTHON;
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

function kitDirectory() {
  return process.resourcesPath && !process.defaultApp
    ? path.join(process.resourcesPath, 'skills', 'kunlu-business-planner')
    : path.join(__dirname, '..', 'resources', 'skills', 'kunlu-business-planner');
}

function safeFileName(value) {
  if (typeof value !== 'string' || !value || /[\\/:*?"<>|\x00-\x1f]/.test(value) || !value.toLowerCase().endsWith('.pptx')) throw new Error('经营规划 PPT 文件名无效');
  return value;
}

async function executeBusinessPlanner(call, root, signal, helpers) {
  const { command, within } = helpers;
  if (!capabilities.includes(call.tool)) throw new Error('不支持的经营规划技能');
  const workspace = await ensureWorkspace(root, call);
  const action = call.tool.replace('local_business_', '');
  const args = { ...(call.arguments || {}) };
  if (action === 'ppt') args.fileName = safeFileName(args.fileName || '鲲鹭科技三一规划.pptx');
  const requestPath = path.join(workspace.work, 'business-planner-request.json');
  await fs.writeFile(requestPath, JSON.stringify({ action, args, output: workspace.output }), 'utf8');
  let proc;
  try {
    proc = await command(await pythonExecutable(), ['-X', 'utf8', path.join(kitDirectory(), 'scripts', 'kla_bridge.py'), requestPath], workspace.work, 660000, signal);
  } catch (error) {
    if (error?.code === 'ENOENT') return { result: { error: '未找到 Python，请安装 Python 3.10+ 并配置 KLA_BUSINESS_PLANNER_PYTHON' } };
    throw error;
  }
  let result;
  try { result = JSON.parse((proc.stdout || '').trim() || '{}'); } catch { throw new Error(`经营规划引擎返回无效结果：${(proc.stderr || '').slice(-500)}`); }
  if (proc.exitCode !== 0 || result.error) return { result: { error: result.error || `经营规划引擎启动失败：${(proc.stderr || '').slice(-1000)}` } };
  if (action !== 'ppt') return { result };
  const outputPath = path.join(workspace.output, args.fileName);
  if (!within(await fs.realpath(outputPath), await fs.realpath(workspace.output))) throw new Error('经营规划成果路径越界');
  const stat = await fs.stat(outputPath);
  if (stat.size > 16 * 1024 * 1024) throw new Error('经营规划 PPT 超过 16 MiB 上传限制');
  const bytes = await fs.readFile(outputPath);
  if (!bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) throw new Error('经营规划引擎未生成有效 PPTX');
  const artifact = { fileName: args.fileName, mimeType: pptMime, contentEncoding: 'base64', content: bytes.toString('base64'), checksum: createHash('sha256').update(bytes).digest('hex') };
  return { result: { ...result, artifact: { fileName: artifact.fileName, mimeType: artifact.mimeType, sizeBytes: stat.size } }, artifact };
}

module.exports = { executeBusinessPlanner, capabilities };
