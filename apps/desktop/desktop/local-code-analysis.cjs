// 代码分析智能体本地执行器：项目扫描、变更影响、源码行号读取（只读）
const fs = require('node:fs/promises');
const path = require('node:path');

const capabilities = ['local_code_scan', 'local_code_impact', 'local_code_read'];

function pythonExecutable() {
  if (process.env.KLA_CODE_ANALYSIS_PYTHON) return process.env.KLA_CODE_ANALYSIS_PYTHON;
  if (process.env.KLA_PPT_PYTHON) return process.env.KLA_PPT_PYTHON;
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

function kitDirectory() {
  return process.resourcesPath && !process.defaultApp
    ? path.join(process.resourcesPath, 'skills', 'code-analysis-kit')
    : path.join(__dirname, '..', 'resources', 'skills', 'code-analysis-kit');
}

// 被分析的 file 必须落在项目目录内，防止借分析之名越界读盘
function resolveWithin(root, relative) {
  const abs = path.resolve(root, relative);
  const normalizedRoot = path.resolve(root);
  if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + path.sep)) throw new Error('文件路径越界：必须位于项目目录内');
  return abs;
}

async function runPython(helpers, root, scriptArgs, signal) {
  const script = scriptArgs[0];
  const outcome = await helpers.command(
    await pythonExecutable(),
    ['-X', 'utf8', path.join(kitDirectory(), 'scripts', script), ...scriptArgs.slice(1)],
    root, 300000, signal,
  );
  if (outcome.exitCode !== 0) {
    const tail = String(outcome.stderr || '').trim().split('\n').slice(-3).join('\n');
    return { result: { error: `代码分析脚本执行失败（exit ${outcome.exitCode}）：${tail || '无 stderr'}` } };
  }
  try {
    return { result: JSON.parse(String(outcome.stdout || '').trim() || '{}') };
  } catch {
    return { result: { error: '脚本输出不是有效 JSON', raw: String(outcome.stdout || '').slice(0, 2000) } };
  }
}

// 带行号读源码片段：证据到行号的基础（默认单次最多 400 行，防止刷屏）
async function readSource(root, args) {
  const abs = resolveWithin(root, args.file);
  let data;
  try {
    data = await fs.readFile(abs);
  } catch {
    return { result: { error: `无法读取文件：${args.file}` } };
  }
  if (data.subarray(0, 4096).includes(0)) return { result: { error: '二进制文件不支持行号读取；请改用扫描或影响面工具获取信息' } };
  if (data.length > 5 * 1024 * 1024) return { result: { error: '文件超过 5MB，请分段读取或用扫描工具获取结构信息' } };
  const lines = data.toString('utf8').split('\n');
  const total = lines.length;
  const start = Math.max(1, Math.floor(args.startLine || 1));
  const end = Math.min(total, Math.floor(args.endLine || start + 399), start + 1999);
  const numbered = [];
  for (let i = start; i <= end; i++) numbered.push(`${String(i).padStart(5)}| ${lines[i - 1] ?? ''}`);
  return {
    result: {
      file: args.file.replace(/\\/g, '/'),
      totalLines: total,
      startLine: start,
      endLine: end,
      truncated: end < total,
      content: numbered.join('\n'),
    },
  };
}

async function executeCodeAnalysis(call, root, signal, helpers) {
  if (!capabilities.includes(call.tool)) throw new Error('不支持的代码分析技能');
  signal.throwIfAborted();
  const a = call.arguments || {};
  const analysisRoot = path.resolve(String(a.root || ''));
  if (!analysisRoot || analysisRoot === path.parse(analysisRoot).root) throw new Error('root 必须是具体的项目目录路径');

  if (call.tool === 'local_code_scan') {
    const scriptArgs = ['scan_project.py', analysisRoot, '--json'];
    if (a.maxDepth) scriptArgs.push('--max-depth', String(a.maxDepth));
    return runPython(helpers, analysisRoot, scriptArgs, signal);
  }
  if (call.tool === 'local_code_impact') {
    const scriptArgs = ['git_impact.py', analysisRoot, '--json'];
    if (a.compareWith) scriptArgs.push('--compare', path.resolve(String(a.compareWith)));
    else if (a.range) scriptArgs.push('--range', String(a.range));
    return runPython(helpers, analysisRoot, scriptArgs, signal);
  }
  return readSource(analysisRoot, a);
}

module.exports = { executeCodeAnalysis, capabilities };
