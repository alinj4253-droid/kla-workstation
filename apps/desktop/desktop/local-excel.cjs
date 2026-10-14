// 经营分析 · Excel 数据分析本地工具（excel-agent-kit 1.0，技能包 excel-pro 1.1.0）
// 技能包位于 resources/skills/excel-pro/（scripts/*.py + references/*.md + SKILL.md），
// 本文件负责：Python 解析 → 路径与大小校验 → 脚本 spawn（超时/取消）→ 产物回传。
// 与 local-ppt.cjs 同一模式：kit 目录在开发期取 ../resources/skills，打包后取 resourcesPath。
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ensureWorkspace } = require('./local-workspace.cjs');

const capabilities = ['local_excel_doctor', 'local_excel_profile', 'local_excel_validate', 'local_excel_report'];
const mimes = { '.json': 'application/json', '.md': 'text/markdown', '.html': 'text/html' };
const EXCEL_LIMIT = 16 * 1024 * 1024; // 单文件 16 MiB，与群聊附件上限一致

// 数值库默认限单线程：低内存环境下 OpenBLAS 多线程缓冲会间歇性分配失败（崩在 import 阶段）；
// 分析脚本数据量小，限线程无损性能；用户可用环境变量覆盖
for (const key of ['OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS']) {
  if (!process.env[key]) process.env[key] = '1';
}

async function pythonExecutable() {
  if (process.env.KLA_EXCEL_PYTHON) return process.env.KLA_EXCEL_PYTHON;
  // 解析链：excel 专用 venv（scripts/setup-excel-runtime.ps1 安装）→ 复用 PPT venv → PATH
  const localAppData = process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), '.local');
  const candidates = [
    path.join(localAppData, 'kla-workstation', 'excel-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    path.join(localAppData, 'kla-workstation', 'ppt-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
  ];
  for (const venv of candidates) {
    try { await fs.access(venv); return venv; } catch { /* 尝试下一个 */ }
  }
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}
function kitDirectory() {
  return process.resourcesPath && !process.defaultApp ? path.join(process.resourcesPath, 'skills', 'excel-pro') : path.join(__dirname, '..', 'resources', 'skills', 'excel-pro');
}
function kitScript(name) { return path.join(kitDirectory(), 'scripts', name); }

// 环境检查：内联探测 Python 与三大依赖，不落临时文件
async function excelDoctor(command) {
  const py = await pythonExecutable();
  const probe = [
    'import importlib, json, sys',
    'mods = {"python": sys.version.split()[0]}',
    'for name in ("pandas", "openpyxl", "matplotlib"):',
    '    try: mods[name] = importlib.import_module(name).__version__',
    '    except Exception: mods[name] = None',
    'print(json.dumps(mods))',
  ].join('\n');
  const proc = await command(py, ['-X', 'utf8', '-c', probe], process.cwd(), 60000, new AbortController().signal);
  if (proc.exitCode !== 0) {
    return { result: { status: 'blocked', pythonPath: py, error: 'Python 不可用：' + (proc.stderr || '').slice(-300), hint: '请安装 Python 3.8+，或用环境变量 KLA_EXCEL_PYTHON 指定已装依赖的解释器' } };
  }
  let mods;
  try { mods = JSON.parse(proc.stdout.trim()); } catch { return { result: { status: 'blocked', pythonPath: py, error: '环境探测输出解析失败' } }; }
  const core = Boolean(mods.pandas && mods.openpyxl);
  const full = core && Boolean(mods.matplotlib);
  const result = {
    status: full ? 'full' : core ? 'partial' : 'blocked',
    pythonPath: py,
    python: mods.python,
    deps: { pandas: mods.pandas, openpyxl: mods.openpyxl, matplotlib: mods.matplotlib },
  };
  if (core && !mods.matplotlib) result.hint = '缺 matplotlib：数据画像与溯源校验可用，HTML 报告不可用。请 pip install matplotlib（或在 KLA_EXCEL_PYTHON 指向已装依赖的解释器）';
  else if (!core) result.hint = '缺核心依赖（pandas/openpyxl）：请 pip install pandas openpyxl matplotlib，或用环境变量 KLA_EXCEL_PYTHON 指定已装依赖的解释器';
  return { result };
}

// 校验 Excel 源文件：后缀、存在性、大小；只读打开，不写回源文件
async function resolveExcelInput(rawPath, root, approved, approvedReadPath, absolute) {
  const input = await approvedReadPath(absolute(rawPath), root, approved);
  if (!/\.(xlsx|xlsm)$/i.test(input)) throw new Error('仅支持 .xlsx/.xlsm 文件（旧版 .xls 请先转换）');
  const stat = await fs.stat(input);
  if (!stat.isFile()) throw new Error('路径不是文件');
  if (stat.size > EXCEL_LIMIT) throw new Error(`Excel 文件限 ${EXCEL_LIMIT / 1024 / 1024} MiB，当前 ${(stat.size / 1024 / 1024).toFixed(1)} MiB`);
  return input;
}

// 运行 kit 脚本并读回 JSON 产物；产物统一落 workspace.output 并回传为群聊成果
async function runKitScript({ py, scriptName, argv, workspace, timeoutMs, signal, command, artifactNames }) {
  const proc = await command(py, ['-X', 'utf8', kitScript(scriptName), ...argv], workspace.work, timeoutMs, signal);
  if (proc.exitCode !== 0) {
    const tail = (proc.stderr || proc.stdout || '').slice(-1200);
    if (/ModuleNotFoundError|ImportError|缺少依赖/.test(tail)) {
      return { result: { error: 'Excel 分析依赖不完整：' + tail.split('\n').filter(Boolean).slice(-3).join('；'), hint: '请先调用 local_excel_doctor 检查环境，并按提示安装依赖或设置 KLA_EXCEL_PYTHON' } };
    }
    return { result: { error: '脚本执行失败（退出码 ' + proc.exitCode + '）：' + tail } };
  }
  const result = {};
  for (const name of artifactNames) {
    const file = path.join(workspace.output, name);
    try {
      const text = await fs.readFile(file, 'utf8');
      if (name.endsWith('.json')) result[name.replace(/\.json$/, '')] = JSON.parse(text);
      else result[name.replace(/\.\w+$/, '')] = text;
    } catch { /* 产物缺失不阻断：摘要仍以 stdout 为准 */ }
  }
  result.stdoutTail = (proc.stdout || '').slice(-4000);
  return { result, outputFiles: artifactNames.map(name => path.join(workspace.output, name)) };
}

// 把文本产物（json/md/html）读出来回传为群聊成果，参照 local-ppt 的 artifacts 结构
async function collectArtifacts(files) {
  const artifacts = [];
  let total = 0;
  for (const file of files) {
    let stat;
    try { stat = await fs.stat(file); } catch { continue; }
    if (!stat.isFile()) continue;
    total += stat.size;
    if (stat.size > EXCEL_LIMIT || total > 32 * 1024 * 1024) throw new Error('Excel 分析产物超过上传限制，文件已保留在本地任务目录');
    const ext = path.extname(file).toLowerCase();
    const mimeType = mimes[ext];
    if (!mimeType) continue;
    const text = await fs.readFile(file, 'utf8');
    artifacts.push({ fileName: path.basename(file), content: text, contentEncoding: 'utf8', mimeType, checksum: createHash('sha256').update(text).digest('hex') });
  }
  return artifacts;
}

async function executeExcel(call, root, signal, approved, helpers) {
  const { command, absolute, approvedReadPath } = helpers;
  signal.throwIfAborted();
  const a = call.arguments || {};
  if (call.tool === 'local_excel_doctor') return excelDoctor(command);

  const workspace = await ensureWorkspace(root, call);
  const py = await pythonExecutable();

  if (call.tool === 'local_excel_profile') {
    const input = await resolveExcelInput(a.path, root, approved, approvedReadPath, absolute);
    const argv = [input, '--out', path.join(workspace.output, 'profile.json'), '--md', path.join(workspace.output, 'profile.md')];
    if (Array.isArray(a.sheets)) for (const s of a.sheets.slice(0, 20)) argv.push('--sheet', String(s).slice(0, 100));
    if (a.maxEnum) argv.push('--max-enum', String(Math.max(1, Math.min(Number(a.maxEnum) || 30, 200))));
    signal.throwIfAborted();
    let proc;
    try { proc = await command(py, ['-X', 'utf8', kitScript('profile_data.py'), ...argv], workspace.work, 300000, signal); }
    catch (e) { if (e.code === 'ENOENT') return { result: { error: '未找到 Python，请安装 Python 3.8+ 或设置 KLA_EXCEL_PYTHON' } }; throw e; }
    if (proc.exitCode !== 0) {
      const tail = (proc.stderr || proc.stdout || '').slice(-1200);
      if (/ModuleNotFoundError|ImportError|缺少依赖/.test(tail)) return { result: { error: 'Excel 画像依赖不完整：' + tail.split('\n').filter(Boolean).slice(-3).join('；'), hint: '请先调用 local_excel_doctor 检查环境' } };
      return { result: { error: '画像失败（退出码 ' + proc.exitCode + '）：' + tail } };
    }
    let profile = null;
    try { profile = JSON.parse(await fs.readFile(path.join(workspace.output, 'profile.json'), 'utf8')); } catch { /* 摘要退化到 stdout */ }
    const summary = profile ? {
      sourceFile: path.basename(String(profile.source_file || input)),
      fileSizeBytes: profile.file_size,
      sheetCount: (profile.sheet_names || []).length,
      sheets: (profile.sheets || []).map(s => ({ name: s.name, rows: s.rows, cols: s.cols, duplicateRows: s.duplicate_rows, issues: (s.issues || []).length })),
      totalIssues: (profile.sheets || []).reduce((n, s) => n + (s.issues || []).length, 0),
    } : null;
    const artifacts = await collectArtifacts([path.join(workspace.output, 'profile.json'), path.join(workspace.output, 'profile.md')]);
    return { result: { ...(summary ? { summary } : {}), stdoutTail: (proc.stdout || '').slice(-4000), uploaded: artifacts.length > 0, files: artifacts.map(x => ({ fileName: x.fileName, mimeType: x.mimeType })) }, ...(artifacts.length ? { artifacts } : {}) };
  }

  if (call.tool === 'local_excel_validate') {
    const input = await resolveExcelInput(a.path, root, approved, approvedReadPath, absolute);
    const argv = [input, '--out', path.join(workspace.output, 'validate.json')];
    if (a.sheet) argv.push('--sheet', String(a.sheet).slice(0, 100));
    for (const col of Array.isArray(a.sum) ? a.sum.slice(0, 20) : []) argv.push('--sum', String(col).slice(0, 100));
    if (a.count) argv.push('--count');
    if (a.filterCol) argv.push('--filter-col', String(a.filterCol).slice(0, 100));
    if (a.filterExclude) argv.push('--filter-exclude', String(a.filterExclude).slice(0, 200));
    if (a.reconcileDetail && a.reconcileSummary) {
      argv.push('--reconcile-detail', String(a.reconcileDetail).slice(0, 100), '--reconcile-summary', String(a.reconcileSummary).slice(0, 100));
      if (a.reconcileDKeys) argv.push('--reconcile-d-keys', String(a.reconcileDKeys).slice(0, 200));
      if (a.reconcileDValue) argv.push('--reconcile-d-value', String(a.reconcileDValue).slice(0, 100));
      if (a.reconcileSKeys) argv.push('--reconcile-s-keys', String(a.reconcileSKeys).slice(0, 200));
      if (a.reconcileSValue) argv.push('--reconcile-s-value', String(a.reconcileSValue).slice(0, 100));
    }
    signal.throwIfAborted();
    let proc;
    try { proc = await command(py, ['-X', 'utf8', kitScript('cross_validate.py'), ...argv], workspace.work, 300000, signal); }
    catch (e) { if (e.code === 'ENOENT') return { result: { error: '未找到 Python，请安装 Python 3.8+ 或设置 KLA_EXCEL_PYTHON' } }; throw e; }
    if (proc.exitCode !== 0) {
      const tail = (proc.stderr || proc.stdout || '').slice(-1200);
      if (/ModuleNotFoundError|ImportError|缺少依赖/.test(tail)) return { result: { error: '溯源校验依赖不完整：' + tail.split('\n').filter(Boolean).slice(-3).join('；'), hint: '请先调用 local_excel_doctor 检查环境' } };
      return { result: { error: '校验失败（退出码 ' + proc.exitCode + '）：' + tail } };
    }
    let report = null;
    try { report = JSON.parse(await fs.readFile(path.join(workspace.output, 'validate.json'), 'utf8')); } catch { /* 摘要退化到 stdout */ }
    const summary = report ? {
      sourceFingerprint: report.source_fingerprint,
      sheetRows: report.sheet_rows,
      totalRows: report.total_rows,
      independentRecalc: report.independent_recalc || null,
      reconcile: report.reconcile || null,
      sourceUnchanged: report.source_unchanged,
    } : null;
    const artifacts = await collectArtifacts([path.join(workspace.output, 'validate.json')]);
    return { result: { ...(summary ? { summary } : {}), stdoutTail: (proc.stdout || '').slice(-4000), uploaded: artifacts.length > 0, files: artifacts.map(x => ({ fileName: x.fileName, mimeType: x.mimeType })) }, ...(artifacts.length ? { artifacts } : {}) };
  }

  if (call.tool === 'local_excel_report') {
    if (Boolean(a.jsonPath) === Boolean(a.content)) throw new Error('请提供 jsonPath 或 content 之一');
    let inputJson;
    if (a.jsonPath) {
      try { await fs.stat(absolute(a.jsonPath)); } catch { throw new Error(`报告输入文件不存在：${String(a.jsonPath).slice(0, 200)}；请先运行 local_excel_profile 或 local_excel_validate 生成结果 JSON，或用 content 内联提供`); }
      inputJson = await approvedReadPath(absolute(a.jsonPath), root, approved);
    } else {
      try { JSON.parse(a.content); } catch { throw new Error('content 不是合法 JSON'); }
      if (a.content.length > 1_000_000) throw new Error('报告输入 JSON 限 100 万字符');
      inputJson = path.join(workspace.input, 'report-input.json');
      await fs.writeFile(inputJson, a.content, 'utf8');
    }
    const name = String(a.fileName || '分析报告.html').replace(/[\\/:*?"<>|\x00-\x1f]/g, '');
    const outHtml = path.join(workspace.output, name.endsWith('.html') ? name : name + '.html');
    const argv = [inputJson, '--out', outHtml];
    if (a.theme === 'light' || a.theme === 'dark') argv.push('--theme', a.theme);
    signal.throwIfAborted();
    let proc;
    try { proc = await command(py, ['-X', 'utf8', kitScript('html_report.py'), ...argv], workspace.work, 300000, signal); }
    catch (e) { if (e.code === 'ENOENT') return { result: { error: '未找到 Python，请安装 Python 3.8+ 或设置 KLA_EXCEL_PYTHON' } }; throw e; }
    if (proc.exitCode !== 0) {
      const tail = (proc.stderr || proc.stdout || '').slice(-1200);
      if (/matplotlib/.test(tail)) return { result: { error: 'HTML 报告需要 matplotlib：' + tail.split('\n').filter(Boolean).slice(-2).join('；'), hint: '请 pip install matplotlib 后重试；数据画像与溯源校验不受影响' } };
      return { result: { error: '报告生成失败（退出码 ' + proc.exitCode + '）：' + tail } };
    }
    const stat = await fs.stat(outHtml);
    const artifacts = await collectArtifacts([outHtml]);
    return { result: { fileName: path.basename(outHtml), sizeBytes: stat.size, uploaded: artifacts.length > 0, stdoutTail: (proc.stdout || '').slice(-2000) }, ...(artifacts.length ? { artifacts } : {}) };
  }

  throw new Error('不支持的 Excel 分析技能');
}

module.exports = { executeExcel, capabilities };
