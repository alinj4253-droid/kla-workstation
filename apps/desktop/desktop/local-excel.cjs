// 经营分析 · Excel 数据分析本地工具（excel-agent-kit 1.1，纯 JS 引擎，无 Python 依赖）
// exceljs 读取工作簿（纯 JS，随 Electron 打包自带）；HTML 报告用内联 SVG 图表（零渲染依赖）。
// 本文件负责：路径与大小校验 → 画像/溯源校验/报告（进程内计算）→ 产物回传。
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ensureWorkspace } = require('./local-workspace.cjs');

const capabilities = ['local_excel_doctor', 'local_excel_profile', 'local_excel_validate', 'local_excel_report'];
const mimes = { '.json': 'application/json', '.md': 'text/markdown', '.html': 'text/html' };
const EXCEL_LIMIT = 16 * 1024 * 1024; // 单文件 16 MiB，与群聊附件上限一致
const MAX_ROWS_PER_SHEET = 200000; // 超大表防御：逐行统计最多取前 20 万行

let engineCache = null;
function exceljs() {
  if (!engineCache) engineCache = require('exceljs');
  return engineCache;
}

// ---------------------------------------------------------------- 单元格取值
// exceljs 的 value 可能是富文本/公式/超链接/错误对象，取「有效显示值」
function plainValue(cell) {
  if (!cell) return null;
  const v = cell.value;
  return plainRaw(v);
}
function plainRaw(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  const t = typeof v;
  if (t === 'number' || t === 'string' || t === 'boolean') return v;
  if (t !== 'object') return null;
  if (Array.isArray(v.richText)) return v.richText.map(x => x.text || '').join('');
  if (v.formula || v.sharedFormula) return v.result === undefined ? null : plainRaw(v.result);
  if (v.error) return null;
  if (v.text !== undefined) return typeof v.text === 'object' && v.text !== null ? plainRaw(v.text) : v.text; // 超链接
  if (v.result !== undefined) return plainRaw(v.result);
  return null;
}
function isBlank(v) { return v === null || v === undefined || (typeof v === 'string' && v.trim() === ''); }
function toNum(v) {
  if (isBlank(v) || typeof v === 'boolean') return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return null;
  const s = String(v).trim().replace(/,/g, '').replace(/，/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
const DATE_TEXT_RE = /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?([ T]\d{1,2}:\d{2}(:\d{2})?)?$/;
function parseDateLoose(v) {
  if (v instanceof Date) return v;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!DATE_TEXT_RE.test(s)) return null;
  const t = new Date(s.replace(/\//g, '-').replace(' ', 'T'));
  return Number.isNaN(t.getTime()) ? null : t;
}
function fmtDateTime(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function num2(x) { return Math.round(x * 100) / 100; }

// 读取工作簿：表头 + 数据行（去掉全空行）；列名→下标映射
async function readWorkbook(input, signal) {
  const ExcelJS = exceljs();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(input); // .xlsx/.xlsm 通用；只读打开，绝不写回
  const sheets = {};
  for (const ws of wb.worksheets) {
    signal.throwIfAborted();
    const headerRow = ws.getRow(1);
    const headers = [];
    const idx = {};
    headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
      const name = String(plainValue(cell) ?? '').trim();
      if (name && idx[name] === undefined) { idx[name] = col - 1; headers[col - 1] = name; }
    });
    const data = [];
    let truncated = false;
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (data.length >= MAX_ROWS_PER_SHEET) { truncated = true; return; }
      const cells = [];
      const vals = row.values || [];
      for (let c = 0; c < vals.length; c++) cells[c] = plainValue(row.getCell(c + 1));
      if (!cells.some(x => !isBlank(x))) return; // 全空行跳过
      data.push(cells);
    });
    sheets[ws.name] = { headers, idx, data, truncated };
  }
  return { wb, sheets };
}
function getSheet(sheets, name) {
  const s = sheets[name];
  if (!s) throw new Error(`sheet 不存在: ${name}（可选: ${Object.keys(sheets).join('、')}）`);
  if (!s.data.length && !s.headers.length) throw new Error(`sheet 为空: ${name}`);
  return s;
}
function cellAt(row, i) { return i >= 0 && i < row.length ? row[i] : null; }

// ---------------------------------------------------------------- 环境检查
async function excelDoctor() {
  try {
    exceljs();
    return { result: { status: 'full', engine: 'exceljs ' + require('exceljs/package.json').version, node: process.version.replace(/^v/, '') } };
  } catch (e) {
    return { result: { status: 'blocked', error: '内置 Excel 引擎加载失败：' + e.message, hint: '请重新安装 KLA Workstation（exceljs 为内置依赖，无需额外安装环境）' } };
  }
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

// ---------------------------------------------------------------- 数据画像
function profileSheet(sheet, name, maxEnum) {
  const { headers, idx, data, truncated } = sheet;
  const colCount = Math.max(headers.filter(Boolean).length, ...data.map(r => r.length), 0);
  const names = [];
  for (let c = 0; c < colCount; c++) names[c] = headers[c] || `列${c + 1}`;

  // 重复行：整行序列化计数，Σ(次数-1) 与 pandas duplicated().sum() 口径一致
  const seen = new Map();
  for (const r of data) {
    const key = r.map(x => (x instanceof Date ? x.toISOString().slice(0, 19) : isBlank(x) ? '' : String(typeof x === 'string' ? x.trim() : x))).join('\u0001');
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  let duplicateRows = 0;
  for (const c of seen.values()) if (c > 1) duplicateRows += c - 1;

  const columns = [];
  const issues = [];
  for (let c = 0; c < colCount; c++) {
    const colName = names[c];
    const values = data.map(r => cellAt(r, c));
    const nonBlank = values.filter(x => !isBlank(x));
    const info = { name: colName, kind: '', n_blank: values.length - nonBlank.length, n_unique: 0 };
    info.blank_pct = values.length ? Math.round(info.n_blank / values.length * 10000) / 100 : 0;

    let ratioNum = 0, ratioDate = 0, nativeNumeric = nonBlank.length > 0, nativeDate = nonBlank.length > 0;
    for (const v of nonBlank) {
      if (typeof v !== 'number') nativeNumeric = false;
      if (!(v instanceof Date)) nativeDate = false;
    }
    if (nonBlank.length) {
      ratioNum = nonBlank.filter(v => toNum(v) !== null).length / nonBlank.length;
      if (!nativeDate && !nativeNumeric) {
        const sample = nonBlank.slice(0, 30).map(v => String(v).trim());
        const hit = sample.filter(s => DATE_TEXT_RE.test(s)).length / sample.length;
        if (hit >= 0.8) ratioDate = sample.filter(s => parseDateLoose(s) !== null).length / sample.length;
      }
    }
    if (!nonBlank.length) info.kind = '空列';
    else if (nativeDate) info.kind = '日期型';
    else if (ratioNum >= 0.999) info.kind = '数值型';
    else if (ratioNum > 0) info.kind = '数值混入文本';
    else if (ratioDate >= 0.999) info.kind = '日期型（文本存储）';
    else info.kind = '文本型';

    const uniq = new Map();
    for (const v of nonBlank) {
      const k = v instanceof Date ? v.toISOString().slice(0, 19) : String(isBlank(v) ? '' : typeof v === 'string' ? v.trim() : v);
      uniq.set(k, (uniq.get(k) || 0) + 1);
    }
    info.n_unique = uniq.size;
    if (info.n_unique > 0 && info.n_unique <= maxEnum) info.enum = [...uniq.keys()].sort();

    if (info.kind === '数值混入文本') {
      const bad = [...new Set(nonBlank.filter(v => toNum(v) === null).map(v => String(v)))].slice(0, 5);
      info.non_numeric_samples = bad;
      issues.push(`字段「${colName}」混入 ${nonBlank.length - nonBlank.filter(v => toNum(v) !== null).length} 个非数值文本（如 ${bad.slice(0, 3)}），建议清洗后再参与计算`);
    }
    if (info.kind === '日期型（文本存储）') issues.push(`字段「${colName}」日期以文本存储，建议统一转为日期类型`);
    if (info.n_blank > 0 && values.length && info.n_blank / values.length > 0.5) issues.push(`字段「${colName}」缺失率高达 ${info.blank_pct}%，慎用`);

    if (nativeNumeric && info.kind === '数值型') {
      const nums = nonBlank.map(v => Number(v));
      info.min = Math.min(...nums); info.max = Math.max(...nums);
      info.mean = Math.round(nums.reduce((a, b) => a + b, 0) / nums.length * 10000) / 10000;
      const nNeg = nums.filter(x => x < 0).length, nZero = nums.filter(x => x === 0).length;
      if (nNeg) info.n_negative = nNeg;
      if (nZero) info.n_zero = nZero;
    } else if (info.kind === '日期型' || info.kind === '日期型（文本存储）') {
      const dts = nonBlank.map(parseDateLoose).filter(Boolean);
      if (dts.length) { info.date_min = fmtDateTime(new Date(Math.min(...dts))); info.date_max = fmtDateTime(new Date(Math.max(...dts))); }
    }
    columns.push(info);
  }
  if (duplicateRows) issues.push(`存在 ${duplicateRows} 行完全重复记录`);
  if (truncated) issues.push(`行数超过 ${MAX_ROWS_PER_SHEET}，仅统计前 ${MAX_ROWS_PER_SHEET} 行`);
  return { name, rows: data.length, cols: colCount, columns, duplicate_rows: duplicateRows, issues };
}

function profileMarkdown(result) {
  const lines = ['# 数据画像报告', '', `- 源文件：\`${path.basename(String(result.source_file))}\`（${result.file_size.toLocaleString('en-US')} 字节）`, `- 分析时间：${result.profiled_at}`, `- 表数量：${result.sheet_names.length}`, ''];
  for (const info of result.sheets) {
    lines.push(`## ${info.name}`, '', `规模：**${info.rows.toLocaleString('en-US')} 行 × ${info.cols} 列**` + (info.duplicate_rows ? ` ｜ 全行重复 **${info.duplicate_rows}** 行` : ''), '', '| 字段 | 形态 | 空值 | 空值占比 | 唯一值 | 取值范围 / 枚举 |', '|---|---|---|---|---|---|');
    for (const c of info.columns) {
      let rng = '';
      if (c.enum) rng = c.enum.slice(0, 8).join(', ') + (c.enum.length > 8 ? ' ...' : '');
      else if (c.min !== undefined) rng = `${c.min} ~ ${c.max}`;
      else if (c.date_min) rng = `${c.date_min} ~ ${c.date_max}`;
      lines.push(`| ${c.name} | ${c.kind} | ${c.n_blank} | ${c.blank_pct}% | ${c.n_unique} | ${rng} |`);
    }
    if (info.issues.length) lines.push('', '**提示：**', '', ...info.issues.map(x => `- ${x}`));
    lines.push('');
  }
  return lines.join('\n');
}

async function excelProfile(a, input, workspace, signal) {
  const { sheets } = await readWorkbook(input, signal);
  const targets = Array.isArray(a.sheets) && a.sheets.length ? a.sheets.map(s => String(s)) : Object.keys(sheets);
  const maxEnum = Math.max(1, Math.min(Number(a.maxEnum) || 30, 200));
  const profiledAt = fmtDateTime(new Date());
  const result = { source_file: input, file_size: (await fs.stat(input)).size, profiled_at: profiledAt, sheet_names: Object.keys(sheets), sheets: [], total_rows: 0 };
  for (const name of targets) {
    if (!sheets[name]) continue;
    const info = profileSheet(sheets[name], name, maxEnum);
    result.sheets.push(info);
    result.total_rows += info.rows;
  }
  const jsonPath = path.join(workspace.output, 'profile.json');
  const mdPath = path.join(workspace.output, 'profile.md');
  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2), 'utf8');
  await fs.writeFile(mdPath, profileMarkdown(result), 'utf8');
  const summary = {
    sourceFile: path.basename(input),
    fileSizeBytes: result.file_size,
    sheetCount: result.sheets.length,
    sheets: result.sheets.map(s => ({ name: s.name, rows: s.rows, cols: s.cols, duplicateRows: s.duplicate_rows, issues: s.issues.length })),
    totalIssues: result.sheets.reduce((n, s) => n + s.issues.length, 0),
  };
  const artifacts = await collectArtifacts([jsonPath, mdPath]);
  return { result: { summary, uploaded: artifacts.length > 0, files: artifacts.map(x => ({ fileName: x.fileName, mimeType: x.mimeType })) }, ...(artifacts.length ? { artifacts } : {}) };
}

// ---------------------------------------------------------------- 溯源校验
function fingerprint(input) {
  const buf = require('node:fs').readFileSync(input);
  return {
    path: input,
    size_bytes: buf.length,
    mtime: fmtDateTime(new Date()),
    md5: createHash('md5').update(buf).digest('hex'),
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
}
function keyNorm(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) { const p = n => String(n).padStart(2, '0'); return `${v.getFullYear()}-${p(v.getMonth() + 1)}`; }
  const s = String(v).trim();
  if (s.length >= 7 && (s[4] === '-' || s[4] === '/')) {
    const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7));
    if (Number.isInteger(y) && Number.isInteger(m) && m >= 1 && m <= 12) return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
    return s;
  }
  return s;
}

async function excelValidate(a, input, workspace, signal) {
  const { sheets } = await readWorkbook(input, signal);
  const report = { validated_at: fmtDateTime(new Date()) };

  // 1. 指纹
  const fp = fingerprint(input);
  report.source_fingerprint = fp;

  // 2. 各表行数
  report.sheet_rows = {};
  let total = 0;
  for (const [name, s] of Object.entries(sheets)) { report.sheet_rows[name] = s.data.length; total += s.data.length; }
  report.total_rows = total;

  // 3. 独立重算
  if (a.sheet) {
    const sheet = getSheet(sheets, String(a.sheet));
    const sumCols = (Array.isArray(a.sum) ? a.sum : []).map(c => String(c));
    const excludeSet = new Set(String(a.filterExclude || '').split(',').map(x => x.trim()).filter(Boolean));
    const filterCol = a.filterCol ? String(a.filterCol) : null;
    const exIdx = filterCol !== null && filterCol in sheet.idx ? sheet.idx[filterCol] : null;
    const totals = {}; const nonNumeric = {};
    for (const c of sumCols) { totals[c] = 0; nonNumeric[c] = 0; }
    let nUsed = 0, nExcluded = 0;
    for (const r of sheet.data) {
      signal.throwIfAborted();
      if (exIdx !== null) {
        const v = cellAt(r, exIdx);
        if (v !== null && v !== undefined && excludeSet.has(String(v).trim())) { nExcluded++; continue; }
      }
      nUsed++;
      for (const c of sumCols) {
        if (!(c in sheet.idx)) continue;
        const raw = cellAt(r, sheet.idx[c]);
        const x = toNum(raw);
        if (x === null) { if (!isBlank(raw)) nonNumeric[c]++; continue; }
        totals[c] += x;
      }
    }
    const recalc = { sheet: String(a.sheet), rows_total: sheet.data.length, rows_used: nUsed, rows_excluded: nExcluded, sums: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, num2(v)])) };
    if (a.count) recalc.count = nUsed;
    if (Object.values(nonNumeric).some(n => n > 0)) recalc.non_numeric_cells = Object.fromEntries(Object.entries(nonNumeric).filter(([, v]) => v > 0));
    report.independent_recalc = recalc;
  }

  // 4. 双向勾稽（明细 vs 汇总，多列键归一化后逐组合比对）
  if (a.reconcileDetail && a.reconcileSummary) {
    const d = getSheet(sheets, String(a.reconcileDetail));
    const s = getSheet(sheets, String(a.reconcileSummary));
    const dKeys = String(a.reconcileDKeys || '').split(',').map(x => x.trim()).filter(Boolean);
    const sKeys = String(a.reconcileSKeys || '').split(',').map(x => x.trim()).filter(Boolean);
    const dValue = String(a.reconcileDValue || ''), sValue = String(a.reconcileSValue || '');
    const agg = new Map();
    for (const r of d.data) {
      signal.throwIfAborted();
      const k = dKeys.map(c => keyNorm(cellAt(r, d.idx[c] ?? -1))).join('\u0001');
      agg.set(k, (agg.get(k) || 0) + (toNum(cellAt(r, d.idx[dValue] ?? -1)) || 0));
    }
    const sMap = new Map();
    for (const r of s.data) {
      const k = sKeys.map(c => keyNorm(cellAt(r, s.idx[c] ?? -1))).join('\u0001');
      sMap.set(k, toNum(cellAt(r, s.idx[sValue] ?? -1)) || 0);
    }
    const allKeys = [...new Set([...agg.keys(), ...sMap.keys()])].sort();
    const onlyDetail = [], onlySummary = [], mismatches = [];
    for (const k of allKeys) {
      const av = agg.get(k), bv = sMap.get(k);
      const label = k.split('\u0001').join(' / ');
      if (av === undefined) onlySummary.push({ key: label, summary: num2(bv) });
      else if (bv === undefined) onlyDetail.push({ key: label, detail: num2(av) });
      else if (Math.abs(av - bv) >= 0.01) mismatches.push({ key: label, detail: num2(av), summary: num2(bv), diff: num2(av - bv) });
    }
    const td = [...agg.values()].reduce((x, y) => x + y, 0), ts = [...sMap.values()].reduce((x, y) => x + y, 0);
    report.reconcile = {
      detail_sheet: String(a.reconcileDetail), summary_sheet: String(a.reconcileSummary),
      n_detail_keys: agg.size, n_summary_keys: sMap.size,
      total_detail: num2(td), total_summary: num2(ts), total_diff: num2(td - ts),
      only_in_detail: onlyDetail, only_in_summary: onlySummary, value_mismatches: mismatches,
    };
  }

  // 5. 源文件哈希复验（确认整个过程未写入）
  report.source_unchanged = fingerprint(input).sha256 === fp.sha256;

  const jsonPath = path.join(workspace.output, 'validate.json');
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  const summary = {
    sourceFingerprint: report.source_fingerprint,
    sheetRows: report.sheet_rows,
    totalRows: report.total_rows,
    independentRecalc: report.independent_recalc || null,
    reconcile: report.reconcile || null,
    sourceUnchanged: report.source_unchanged,
  };
  const artifacts = await collectArtifacts([jsonPath]);
  return { result: { summary, uploaded: artifacts.length > 0, files: artifacts.map(x => ({ fileName: x.fileName, mimeType: x.mimeType })) }, ...(artifacts.length ? { artifacts } : {}) };
}

// ---------------------------------------------------------------- HTML 报告（内联 SVG，零渲染依赖）
const THEMES = {
  light: {
    bg: '#F4F6FA', card: '#FFFFFF', ink: '#1B2430', sub: '#5B6879', line: '#E3E8EF', grid: '#E9EEF5',
    up: '#D93B3B', down: '#1E9E5A', accent: '#2F6BFF', accent2: '#7A5AF8', accent3: '#12B76A',
    note_info: ['#F1F6FF', '#C8DAFB', '#2B4C8C'], note_warn: ['#FFF6E5', '#F0DBA8', '#8A6200'],
    note_ok: ['#EAF7EF', '#B9E3CB', '#146B41'], note_risk: ['#FDECEC', '#F5C6C6', '#8C2F26'],
  },
  dark: {
    bg: '#0F1218', card: '#181D26', ink: '#E8EDF5', sub: '#98A2B3', line: '#2A303C', grid: '#232936',
    up: '#FF5C5C', down: '#22C55E', accent: '#4C8DFF', accent2: '#9B7BFF', accent3: '#2DD4A7',
    note_info: ['#16223A', '#2A4A7A', '#A8C6F5'], note_warn: ['#33280F', '#5C4A1A', '#F0D28A'],
    note_ok: ['#10291C', '#1E4D33', '#8FE0B4'], note_risk: ['#2E1516', '#5C2A2A', '#F5A8A8'],
  },
};
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtNum = v => Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });

function niceTicks(min, max, n = 4) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= n) || mag * 10;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = []; for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { lo, hi, ticks };
}

function svgFrame(title, th, inner, w = 1100, h = 420) {
  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(title)}" style="width:100%;height:auto;display:block;font-family:'Microsoft YaHei','PingFang SC',sans-serif">`
    + `<rect x="0" y="0" width="${w}" height="${h}" fill="${th.card}"/>`
    + `<text x="${w / 2}" y="34" text-anchor="middle" font-size="17" font-weight="bold" fill="${th.ink}">${esc(title)}</text>`
    + inner + `</svg>`;
}
function yAxisTicks(ticks, x0, y0, h, th, fmt) {
  let s = '';
  for (const t of ticks) {
    const y = y0 + h - (t - ticks[0]) / (ticks[ticks.length - 1] - ticks[0] || 1) * h;
    s += `<text x="${x0 - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="${th.sub}">${fmt(t)}</text>`
      + `<line x1="${x0}" y1="${y}" x2="${x0 + 1000 - 40}" y2="${y}" stroke="${th.grid}" stroke-width="1"/>`;
  }
  return s;
}

function svgLineChart(spec, th) {
  const cats = spec.categories || [], series = spec.series || [];
  const W = 1100, H = 420, L = 92, R = 30, T = 60, B = 66, plotW = W - L - R, plotH = H - T - B;
  const all = series.flatMap(s => s.data || []).filter(v => Number.isFinite(v));
  if (!all.length || !cats.length) return svgFrame(spec.title || '', th, `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${th.sub}">无数据</text>`);
  const { lo, hi, ticks } = niceTicks(Math.min(0, ...all), Math.max(...all));
  const px = i => L + (cats.length === 1 ? plotW / 2 : i * plotW / (cats.length - 1));
  const py = v => T + plotH - (v - lo) / (hi - lo) * plotH;
  const colors = [th.accent, th.accent2, th.accent3];
  let inner = yAxisTicks(ticks, L, T, plotH, th, t => (spec.format === 'k' ? Math.round(t / 1000) + 'k' : fmtNum(t)));
  const rot = spec.rotation || (cats.length > 12 ? 35 : 0);
  cats.forEach((c, i) => {
    const x = px(i);
    inner += `<text x="${x}" y="${T + plotH + 22}" text-anchor="${rot ? 'end' : 'middle'}" font-size="11" fill="${th.sub}"${rot ? ` transform="rotate(-${rot} ${x} ${T + plotH + 22})"` : ''}>${esc(c)}</text>`;
  });
  series.forEach((s, si) => {
    const pts = (s.data || []).map((v, i) => `${Number.isFinite(v) ? px(i).toFixed(1) + ',' + py(v).toFixed(1) : ''}`).filter(Boolean).join(' ');
    inner += `<polyline points="${pts}" fill="none" stroke="${colors[si % 3]}" stroke-width="2.4" stroke-linejoin="round"/>`;
    (s.data || []).forEach((v, i) => { if (Number.isFinite(v)) inner += `<circle cx="${px(i).toFixed(1)}" cy="${py(v).toFixed(1)}" r="4" fill="${colors[si % 3]}"/>`; });
  });
  if (series.length > 1) series.forEach((s, si) => {
    inner += `<circle cx="${L + 14 + si * 130}" cy="${T - 14}" r="5" fill="${colors[si % 3]}"/><text x="${L + 26 + si * 130}" y="${T - 9}" font-size="12" fill="${th.sub}">${esc(s.name || '')}</text>`;
  });
  return svgFrame(spec.title || '', th, inner);
}

function svgBarChart(spec, th) {
  const cats = spec.categories || [], series = spec.series || [];
  const vals = (series[0] && series[0].data) || [];
  const W = 1100, H = 420, L = 92, R = 30, T = 60, B = 66, plotW = W - L - R, plotH = H - T - B;
  if (!vals.length) return svgFrame(spec.title || '', th, `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${th.sub}">无数据</text>`);
  const updown = spec.palette === 'updown';
  const { lo, hi, ticks } = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals));
  const zeroY = T + plotH - (0 - lo) / (hi - lo || 1) * plotH;
  const bw = plotW / Math.max(vals.length, 1) * 0.62, gap = plotW / Math.max(vals.length, 1);
  let inner = yAxisTicks(ticks, L, T, plotH, th, t => (spec.format === 'k' ? Math.round(t / 1000) + 'k' : fmtNum(t)));
  const rot = spec.rotation || (cats.length > 12 ? 35 : 0);
  vals.forEach((v, i) => {
    const x = L + gap * i + (gap - bw) / 2;
    const y = v >= 0 ? T + plotH - (v - lo) / (hi - lo) * plotH : zeroY;
    const hgt = Math.abs((v - 0) / (hi - lo || 1) * plotH);
    inner += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(hgt, 1).toFixed(1)}" fill="${updown ? (v >= 0 ? th.up : th.down) : th.accent}"/>`
      + `<text x="${(x + bw / 2).toFixed(1)}" y="${(v >= 0 ? y - 6 : y + hgt + 14).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="bold" fill="${th.ink}">${fmtNum(v)}</text>`;
    const cx = L + gap * i + gap / 2;
    inner += `<text x="${cx.toFixed(1)}" y="${T + plotH + 22}" text-anchor="${rot ? 'end' : 'middle'}" font-size="11" fill="${th.sub}"${rot ? ` transform="rotate(-${rot} ${cx.toFixed(1)} ${T + plotH + 22})"` : ''}>${esc(cats[i] ?? '')}</text>`;
  });
  inner += `<line x1="${L}" y1="${zeroY.toFixed(1)}" x2="${W - R}" y2="${zeroY.toFixed(1)}" stroke="${th.sub}" stroke-width="1"/>`;
  return svgFrame(spec.title || '', th, inner);
}

function svgHBarChart(spec, th) {
  const cats = spec.categories || [], vals = (spec.series[0] && spec.series[0].data) || [];
  const W = 1100, rowH = 44, T = 60, L = 190, R = 30;
  const H = T + cats.length * rowH + 30;
  if (!vals.length) return svgFrame(spec.title || '', th, `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${th.sub}">无数据</text>`);
  const max = Math.max(...vals, 0) || 1, plotW = W - L - R - 90;
  const colors = [th.accent, th.accent2, th.accent3];
  let inner = '';
  cats.forEach((c, i) => {
    const y = T + i * rowH, v = vals[i] || 0;
    const w = Math.abs(v) / max * plotW;
    inner += `<text x="${L - 10}" y="${y + rowH / 2 + 5}" text-anchor="end" font-size="12" fill="${th.ink}">${esc(c)}</text>`
      + `<rect x="${L}" y="${y + 6}" width="${Math.max(w, 1).toFixed(1)}" height="${rowH - 16}" rx="5" fill="${colors[i % 3]}"/>`
      + `<text x="${(L + w + 8).toFixed(1)}" y="${y + rowH / 2 + 5}" font-size="12" font-weight="bold" fill="${th.ink}">${fmtNum(v)}</text>`;
  });
  return svgFrame(spec.title || '', th, inner);
}
function makeChart(spec, th) {
  const type = spec.type === 'hbar' ? 'hbar' : spec.type === 'bar' ? 'bar' : 'line';
  return type === 'line' ? svgLineChart(spec, th) : type === 'bar' ? svgBarChart(spec, th) : svgHBarChart(spec, th);
}

function renderHtml(data, theme) {
  const th = THEMES[theme] || THEMES.light;
  const kpis = data.kpis || [];
  const kpiCard = k => `<div class="metric${k.highlight ? ' hl' : ''}"><div class="ml">${esc(k.label || '')}</div><div class="mv">${esc(k.value || '')}</div><div class="ms">${esc(k.sub || '')}</div></div>`;
  let kpiHtml = '';
  if (kpis.length) kpiHtml = '<div class="grid g4">' + kpis.map(kpiCard).join('') + '</div>';
  const secHtml = (data.sections || []).map((s, i) => {
    const block = [`<h2><span class="no">${String(i + 1).padStart(2, '0')}</span>${esc(s.heading || '')}</h2>`];
    if (s.lead) block.push(`<p class="lead">${esc(s.lead)}</p>`);
    for (const k of s.kpis || []) block.push(`<div class="grid g3">${kpiCard(k)}</div>`);
    for (const ch of s.charts || []) block.push(`<div class="panel">${makeChart(ch, th)}</div>`);
    for (const tb of s.tables || []) {
      const ar = new Set(tb.align_right || []);
      const head = (tb.headers || []).map((h, j) => `<th${ar.has(j) ? ' style="text-align:right"' : ''}>${esc(h)}</th>`).join('');
      const body = (tb.rows || []).map(row => '<tr>' + row.map((c, j) => ar.has(j) ? `<td class="num">${esc(c)}</td>` : `<td>${tb.raw_html ? c : esc(c)}</td>`).join('') + '</tr>').join('');
      if (tb.title) block.push(`<h3 class="sub-h">${esc(tb.title)}</h3>`);
      block.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
    }
    for (const n of s.notes || []) {
      const [bg, bd, fg] = th[`note_${n.level || 'info'}`] || th.note_info;
      block.push(`<div class="notes" style="background:${bg};border-color:${bd};color:${fg}">${n.html || ''}</div>`);
    }
    return block.join('\n');
  }).join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(data.title || '分析报告')}</title>
<style>
  * { box-sizing:border-box; }
  body { margin:0; background:${th.bg}; color:${th.ink};
         font-family:"Microsoft YaHei","PingFang SC","Segoe UI",system-ui,sans-serif;
         font-size:14px; line-height:1.7; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:1140px; margin:0 auto; padding:34px 26px 70px; }
  .hero { background:linear-gradient(135deg,${th.accent} 0%,${th.accent2} 100%);
          border-radius:18px; padding:30px 34px; color:#fff;
          box-shadow:0 10px 30px rgba(47,107,255,.22); }
  .hero h1 { margin:0 0 6px; font-size:25px; letter-spacing:.4px; }
  .hero p { margin:0; opacity:.93; font-size:13.5px; }
  .hero .tags { margin-top:14px; display:flex; gap:8px; flex-wrap:wrap; }
  .hero .tags span { background:rgba(255,255,255,.2); border-width:1px; border-style:solid; border-color:rgba(255,255,255,.3);
                     border-radius:20px; padding:3px 12px; font-size:12px; }
  h2 { font-size:18px; margin:42px 0 6px; padding-left:12px;
       border-left-width:4px; border-left-style:solid; border-left-color:${th.accent}; color:${th.ink}; }
  h2 .no { color:${th.accent}; font-weight:800; margin-right:6px; }
  h3.sub-h { font-size:15px; margin:22px 0 8px; color:${th.ink}; }
  .lead { color:${th.sub}; font-size:13px; margin:0 0 18px 16px; }
  .grid { display:grid; gap:14px; }
  .g4 { grid-template-columns:repeat(4,1fr); }
  .g3 { grid-template-columns:repeat(3,1fr); }
  .metric { background:${th.card}; border-width:1px; border-style:solid; border-color:${th.line}; border-radius:14px;
            padding:18px 18px 16px; box-shadow:0 2px 10px rgba(20,40,80,.04); }
  .metric.hl { border-color:${th.accent}; }
  .ml { font-size:12.5px; color:${th.sub}; }
  .mv { font-size:25px; font-weight:800; margin:6px 0 2px;
        font-variant-numeric:tabular-nums; }
  .ms { font-size:11.5px; color:${th.sub}; opacity:.85; }
  .panel { background:${th.card}; border-width:1px; border-style:solid; border-color:${th.line}; border-radius:14px;
           padding:6px 4px 10px; margin-top:14px; box-shadow:0 2px 10px rgba(20,40,80,.04); }
  .panel svg { width:100%; height:auto; display:block; }
  table { width:100%; border-collapse:collapse; background:${th.card};
          border-radius:14px; overflow:hidden; border-width:1px; border-style:solid; border-color:${th.line};
          font-size:13px; margin-top:12px; }
  thead th { background:${th.bg}; text-align:left; padding:11px 14px;
             font-weight:700; font-size:12.5px; white-space:nowrap; color:${th.ink}; }
  tbody td { padding:10px 14px; border-top-width:1px; border-top-style:solid; border-top-color:${th.line}; vertical-align:top; }
  .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .notes { border-width:1px; border-style:solid; border-radius:12px; padding:14px 18px; font-size:13px;
           margin-top:14px; }
  .foot { margin-top:46px; padding-top:18px; border-top-width:1px; border-top-style:solid; border-top-color:${th.line};
          color:${th.sub}; font-size:12px; text-align:center; }
  @media (max-width:860px) {
    .g4,.g3 { grid-template-columns:repeat(2,1fr); }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    <h1>${esc(data.title || '分析报告')}</h1>
    ${data.subtitle ? `<p>${esc(data.subtitle)}</p>` : ''}
    ${(data.tags || []).length ? `<div class="tags">${data.tags.map(x => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
  </div>
  ${kpiHtml}
  ${secHtml}
  ${data.footer ? `<div class="foot">${esc(data.footer)}</div>` : ''}
</div>
</body>
</html>`;
}

async function excelReport(a, root, workspace, approved, approvedReadPath, absolute) {
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
  const data = JSON.parse(await fs.readFile(inputJson, 'utf8'));
  const theme = a.theme === 'dark' || a.theme === 'light' ? a.theme : (data.theme === 'dark' ? 'dark' : 'light');
  const html = renderHtml(data, theme);
  const name = String(a.fileName || '分析报告.html').replace(/[\\/:*?"<>|\x00-\x1f]/g, '');
  const outHtml = path.join(workspace.output, name.endsWith('.html') ? name : name + '.html');
  await fs.writeFile(outHtml, html, 'utf8');
  const stat = await fs.stat(outHtml);
  const artifacts = await collectArtifacts([outHtml]);
  return { result: { fileName: path.basename(outHtml), sizeBytes: stat.size, uploaded: artifacts.length > 0, message: `报告已生成：主题 ${theme}，${(stat.size / 1024).toFixed(1)} KB，${(data.sections || []).length} 章节 / ${(data.kpis || []).length} KPI` }, ...(artifacts.length ? { artifacts } : {}) };
}

// ---------------------------------------------------------------- 工具分发
async function executeExcel(call, root, signal, approved, helpers) {
  const { absolute, approvedReadPath } = helpers;
  signal.throwIfAborted();
  const a = call.arguments || {};
  if (call.tool === 'local_excel_doctor') return excelDoctor();

  const workspace = await ensureWorkspace(root, call);
  if (call.tool === 'local_excel_profile') {
    const input = await resolveExcelInput(a.path, root, approved, approvedReadPath, absolute);
    return excelProfile(a, input, workspace, signal);
  }
  if (call.tool === 'local_excel_validate') {
    const input = await resolveExcelInput(a.path, root, approved, approvedReadPath, absolute);
    return excelValidate(a, input, workspace, signal);
  }
  if (call.tool === 'local_excel_report') {
    return excelReport(a, root, workspace, approved, approvedReadPath, absolute);
  }
  throw new Error('不支持的 Excel 分析技能');
}

module.exports = { executeExcel, capabilities };
