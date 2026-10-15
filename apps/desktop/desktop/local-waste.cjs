// 经营分析（垃圾量分析）本地工具（biz-agent-kit 2.0）
// 核心逻辑移植自参考项目 route-optimizer（route-optimizer-api/biz-analysis-routes.js）：
//   - 快照聚合 /report/generate 的营收（垃圾量）域：KPI/趋势同比/作业所分解/分类结构（2224-2788 行）
//   - 明细接口：时段热力图 / 分类同比 / 班次垃圾量 / 本所vs公司均值 / 作业所×类型堆叠（3523-3660、4640-4840、7258-7310 行）
//   - 双库架构：快照库 biz_snapshot（查询主路径）+ 第三方业务库 yh_onepas_uat（明细明细口径，gb_garbage_fill/gb_weighbridge）
//   - 口径：总垃圾量=Σ(填报+地磅)；日均=总量÷天数；收运覆盖率=快照收运率区间 AVG（单日=实际点位÷计划点位×100）；
//           漏收率=100−覆盖率；同比=(本期−同期)/同期×100；趋势对位键=年内相对位置（季报按序号对位）
// 纯 Node + mysql2，仅在用户本地设备执行；数据库凭据来自环境变量或 configs/waste-db-config.json。
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const capabilities = ['local_waste_status', 'local_waste_report', 'local_waste_detail', 'local_biz_configure', 'local_biz_schema', 'local_biz_query'];

// ==================== 统一连接配置（多连接 + active 模型） ====================
// 配置文件：configs/biz-db-config.json = { active: 'default', connections: { <名称>: {host,port,user,password,database} } }
// 默认连接指向当前部署的快照库（behavior_analysis）；凭据可来自环境变量 KLA_BIZ_DB_* 或智能体对话配置（local_biz_configure）。
const CONFIG_FILE = path.join(__dirname, 'configs', 'biz-db-config.json');
const DEFAULT_CONNECTION = { host: '192.168.128.128', port: 3306, database: 'behavior_analysis' };

function loadConnectionsFile() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; }
}
function saveConnectionsFile(j) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(j, null, 2), 'utf8');
}
function envConnection() {
  if (process.env.KLA_BIZ_DB_HOST || process.env.KLA_BIZ_DB_DATABASE) {
    return { host: process.env.KLA_BIZ_DB_HOST, port: Number(process.env.KLA_BIZ_DB_PORT || 3306), user: process.env.KLA_BIZ_DB_USER, password: process.env.KLA_BIZ_DB_PASSWORD || '', database: process.env.KLA_BIZ_DB_DATABASE };
  }
  return null;
}
// 当前生效连接：环境变量注入 default > 配置文件 active > 默认骨架（缺凭据则 incomplete）
function resolveActiveConnection() {
  const j = loadConnectionsFile();
  const name = (j && j.active) || 'default';
  let c = j && j.connections && j.connections[name];
  if (name === 'default' && !c) c = envConnection() || { ...DEFAULT_CONNECTION };
  if (!c) c = { ...DEFAULT_CONNECTION };
  const incomplete = !(c.host && c.database) || c.user === undefined || c.user === null;
  return { name, host: c.host, port: Number(c.port || 3306), user: c.user, password: c.password === undefined ? '' : c.password, database: c.database, incomplete };
}
// 连接参数只取数据库五元组，避免把 name/incomplete 等传给 mysql2
function connOpts(c, extra) { return { host: c.host, port: c.port, user: c.user, password: c.password, database: c.database, ...(extra || {}) }; }

function configHint() {
  return '当前数据源未配置完整。请通过对话提供数据库信息（如「连接 MySQL 192.168.128.128:3306/behavior_analysis，用户 xx 密码 xx」），智能体会写入 configs/biz-db-config.json；或设置环境变量 KLA_BIZ_DB_HOST/PORT/USER/PASSWORD/DATABASE';
}

// ==================== 日期/周期（biz-analysis-routes.js:2159-2200 同口径） ====================
function pad2(n) { return String(n).padStart(2, '0'); }
function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
// 参数中文归一化兜底：与 contracts 的 cnAlias 对齐；即使调用未经 zod 预处理（如直连本地工具）也正确解析
const normPeriodType = v => ({ '年报': 'year', '年度': 'year', '季报': 'quarter', '季度': 'quarter', '月报': 'month', '月度': 'month' }[String(v == null ? '' : v).trim()] || v || 'year');
const normAction = v => ({ '设置': 'set', '新增': 'set', '创建': 'set', '添加': 'set', '连接': 'set', '切换': 'activate', '激活': 'activate', '删除': 'remove', '移除': 'remove', '列表': 'list', '查看': 'list' }[String(v == null ? '' : v).trim()] || v || 'list');
const normKind = v => ({ '热力图': 'heatmap', '分类同比': 'category_yoy', '班次': 'shift', '作业所': 'unit_category', '堆叠': 'unit_category', '均值': 'unit_vs_avg', '对比': 'unit_vs_avg' }[String(v == null ? '' : v).trim()] || v);

function resolvePeriod(p) {
  const scope = p.scope || 'company';
  const periodType = normPeriodType(p.periodType);
  let year = parseInt(p.year, 10);
  if (!year || year < 2000 || year > 2100) year = new Date().getFullYear();
  const quarter = Math.min(Math.max(parseInt(p.quarter, 10) || 1, 1), 4);
  const month = Math.min(Math.max(parseInt(p.month, 10) || 1, 1), 12);
  let start = `${year}-01-01`, end = `${year}-12-31`;
  if (periodType === 'quarter') { const m = (quarter - 1) * 3 + 1; start = `${year}-${pad2(m)}-01`; end = `${year}-${pad2(m + 2)}-${pad2(lastDayOfMonth(year, m + 2))}`; }
  else if (periodType === 'month') { start = `${year}-${pad2(month)}-01`; end = `${year}-${pad2(month)}-${pad2(lastDayOfMonth(year, month))}`; }
  const pYear = year - 1;
  let pStart = `${pYear}-01-01`, pEnd = `${pYear}-12-31`;
  if (periodType === 'quarter') { const m = (quarter - 1) * 3 + 1; pStart = `${pYear}-${pad2(m)}-01`; pEnd = `${pYear}-${pad2(m + 2)}-${pad2(lastDayOfMonth(pYear, m + 2))}`; }
  else if (periodType === 'month') { pStart = `${pYear}-${pad2(month)}-01`; pEnd = `${pYear}-${pad2(month)}-${pad2(lastDayOfMonth(pYear, month))}`; }
  return { scope, periodType, year, quarter, month, start, end, pStart, pEnd };
}
function makeChange(cur, prev, { decimals = 1 } = {}) {
  if (prev === 0 || cur === null || prev === null || !isFinite(cur / prev)) {
    return { change: '— 去年同期无数据', cls: 'neutral', hot: false, pct: null };
  }
  const pct = (cur - prev) / prev * 100;
  const dirUp = pct >= 0;
  return { change: `${dirUp ? '↑' : '↓'} 同比 ${dirUp ? '+' : ''}${pct.toFixed(decimals)}%`, cls: dirUp ? 'up' : 'down', hot: Math.abs(pct) >= 20, pct: parseFloat(pct.toFixed(decimals)) };
}

// ==================== 垃圾类型码表（biz-analysis-routes.js:135-160 兜底） ====================
const WORK_TYPE_NAMES = Object.freeze({
  '1': '其他垃圾', '2': '厨余垃圾', '4': '生活有害', '5': '低值可回收', '6': '玻璃陶瓷',
  '9': '飞灰收运', '10': '小门诊部医废收运', '12': '污泥收运', '13': '飞灰固化块', '14': '大医院医废收运',
  '15': '道路清洁', '16': '餐厨垃圾', '17': '公务用车', '18': '大件垃圾', '19': '工业危废',
  '20': '建筑装修垃圾', '21': '绿化垃圾', '22': '日常巡查保障'
});
function resolveWorkTypeName(raw) {
  if (raw === null || raw === undefined) return '未知';
  const key = String(raw).trim();
  return WORK_TYPE_NAMES[key] || key;
}
async function loadDict(conn, dictType) {
  try {
    const [rows] = await conn.execute('SELECT code, name FROM ss_dict_code WHERE dict_type = ?', [dictType]);
    const m = {};
    for (const r of rows) m[String(r.code)] = String(r.name);
    return m;
  } catch { return {}; }
}

// ==================== 内置演示数据（未连接数据库时的默认数据源） ====================
// demo-data/biz-snapshot.json：2025-10-01 ~ 2026-10-13 × 3 单元快照（口径同真实 biz_snapshot）
// demo-data/waste-records.json：2025-10 与 2026-10 两个 13 天窗口的收运记录（供明细工具）
const DEMO_DIR = path.join(__dirname, 'demo-data');
let demoCache = null;
function loadDemoData() {
  if (demoCache) return demoCache;
  try {
    demoCache = {
      snapshot: JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'biz-snapshot.json'), 'utf8')),
      records: JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'waste-records.json'), 'utf8')),
    };
  } catch { demoCache = { snapshot: [], records: [] }; }
  return demoCache;
}
const DEMO_NOTE = '当前为内置演示数据模式（未连接数据库，数据由本地生成、口径与真实系统一致）。在对话中提供数据库连接信息即可切换真实数据源。';
const isDemoMode = cfg => Boolean(cfg.incomplete);

// ---------- 演示数据聚合（口径与 SQL 版一致） ----------
const sum = a => a.reduce((x, y) => x + (Number(y) || 0), 0);
const avg = a => (a.length ? sum(a) / a.length : 0);
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const inRange = (d, s, e) => d >= s && d <= e;
const periodLabel = (dateStr, periodType) => periodType === 'month' ? dateStr : dateStr.slice(0, 7);
const joinKey = (dateStr, periodType) => periodType === 'month' ? dateStr.slice(5, 10) : dateStr.slice(5, 7);
const dowIndex = dateStr => (new Date(dateStr + 'T00:00:00+08:00').getDay() + 6) % 7; // 周一=0

function demoStatus() {
  const { snapshot, records } = loadDemoData();
  const units = [...new Set(snapshot.filter(r => r.unit !== '').map(r => r.unit))];
  return { result: {
    mode: 'demo',
    connection: { name: 'demo', database: '(内置演示数据)' },
    tableCount: 2,
    tableReady: true,
    snapshot: { minDate: snapshot[0]?.snapshot_date || null, maxDate: snapshot[snapshot.length - 1]?.snapshot_date || null, totalRecords: snapshot.length, totalDays: new Set(snapshot.map(r => r.snapshot_date)).size, totalUnits: units.length + 1 },
    units,
    recordsWindow: records.length ? `${records.reduce((a, b) => (a.ts < b.ts ? a : b)).ts.slice(0, 10)} ~ ${records.reduce((a, b) => (a.ts > b.ts ? a : b)).ts.slice(0, 10)}` : null,
    warnings: [],
    note: DEMO_NOTE
  } };
}

function demoSchema() {
  const { snapshot } = loadDemoData();
  const row = snapshot[0] || {};
  const col = (name, type, comment) => ({ name, type, comment });
  return {
    database: '(内置演示数据)', connection: 'demo',
    tables: [
      { name: 'biz_snapshot', approxRows: snapshot.length, comment: '经营分析每日快照（演示）', columns: [
        col('snapshot_date', 'DATE', '数据日期（与 unit 联合唯一）'), col('unit', 'VARCHAR(100)', "区域/作业所，''=公司级"),
        col('revenue_垃圾量', 'DECIMAL(15,2)', '当日进厂填报量 Σgb_garbage_fill.fill_num（吨）'),
        col('revenue_地磅垃圾量', 'DECIMAL(15,2)', '当日地磅净重 Σgb_weighbridge.suttle（吨，status=1）'),
        col('revenue_趟次', 'INT', '进厂车次 + 有效过磅车次'),
        col('revenue_覆盖点位', 'INT', '当日实际收运点位（峰值口径）'), col('revenue_任务数', 'INT', '当日收运任务数'),
        col('revenue_计划点位', 'INT', '当日计划点位'), col('revenue_实际收运', 'INT', '当日实际收运点位'),
        col('revenue_收运率', 'DECIMAL(5,1)', '当日收运率 = 实际收运 ÷ 计划点位 × 100'),
        col('revenue_作业类型分布', 'TEXT', 'JSON：{"1": 吨, "2": 吨, "16": 吨, "5": 吨}'),
        ...Object.keys(row).filter(k => !['snapshot_date','unit','revenue_垃圾量','revenue_地磅垃圾量','revenue_趟次','revenue_覆盖点位','revenue_任务数','revenue_计划点位','revenue_实际收运','revenue_收运率','revenue_作业类型分布'].includes(k)).map(k => col(k, '?', '演示字段'))
      ] },
      { name: 'waste_records', approxRows: loadDemoData().records.length, comment: '收运记录（演示：填报+地磅合并，近两个 10 月窗口）', columns: [
        col('ts', 'DATETIME', '收运/过磅时间'), col('wt', 'VARCHAR', '垃圾类型码（1 其他/2 厨余/16 餐厨/5 低值可回收）'),
        col('v', 'DECIMAL', '重量（吨）'), col('uname', 'VARCHAR', '作业所名'), col('startMin', 'INT', '开始分钟数(当日)'), col('endMin', 'INT', '结束分钟数(当日)')
      ] }
    ],
    samples: [],
    note: DEMO_NOTE + ' 演示模式不支持任意 SQL；分析请用 local_waste_status / local_waste_report / local_waste_detail。'
  };
}

function demoWasteReport(a) {
  const { scope, periodType, year, quarter, month, start, end, pStart, pEnd } = resolvePeriod(a);
  const unit = scope === 'company' ? '' : scope;
  const periodTypeLabel = periodType === 'year' ? '年报' : periodType === 'quarter' ? '季报' : '月报';
  const periodLabelTxt = periodType === 'year' ? `${year}年` : periodType === 'quarter' ? `${year}年第${quarter}季度` : `${year}年${month}月`;
  const daysInPeriod = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
  let trendPrevStart = pStart, trendPrevEnd = pEnd;
  if (periodType === 'quarter') {
    if (quarter > 1) { const pm = (quarter - 2) * 3 + 1; trendPrevStart = `${year}-${pad2(pm)}-01`; trendPrevEnd = `${year}-${pad2(pm + 2)}-${pad2(lastDayOfMonth(year, pm + 2))}`; }
    else { trendPrevStart = `${year - 1}-10-01`; trendPrevEnd = `${year - 1}-12-31`; }
  }
  const { snapshot } = loadDemoData();
  if (unit) {
    const units = [...new Set(snapshot.filter(x => x.unit !== '').map(x => x.unit))];
    if (!units.includes(unit)) throw new Error(`演示数据中不存在作业所「${unit}」；可用作业所：${units.join('、')}`);
  }
  const agg = rows => ({
    垃圾量: r2(sum(rows.map(x => x.revenue_垃圾量 + x.revenue_地磅垃圾量))),
    趟次: sum(rows.map(x => x.revenue_趟次)),
    覆盖点位: Math.max(0, ...rows.map(x => x.revenue_覆盖点位)),
    收运率: r1(avg(rows.map(x => x.revenue_收运率)))
  });
  const cur = agg(snapshot.filter(x => inRange(x.snapshot_date, start, end) && x.unit === unit));
  const prev = agg(snapshot.filter(x => inRange(x.snapshot_date, pStart, pEnd) && x.unit === unit));
  // 分类结构
  const wtAcc = { '可回收物': 0, '有害垃圾': 0, '厨余垃圾': 0, '其他垃圾': 0 };
  for (const x of snapshot.filter(x => inRange(x.snapshot_date, start, end) && (unit ? x.unit === unit : x.unit !== ''))) {
    try { const obj = JSON.parse(x.revenue_作业类型分布 || '{}'); for (const [k, v] of Object.entries(obj)) { const name = resolveWorkTypeName(k); wtAcc[name] = (wtAcc[name] || 0) + parseFloat(v || 0); } } catch { /* 忽略 */ }
  }
  const workTypePie = Object.entries(wtAcc).filter(([, value]) => value > 0).map(([name, value]) => ({ name, value: r2(value) })).sort((x, y) => y.value - x.value);
  // 趋势
  const groupRows = (s, e) => {
    const m = new Map();
    for (const x of snapshot.filter(x => inRange(x.snapshot_date, s, e) && x.unit === unit)) {
      const label = periodLabel(x.snapshot_date, periodType);
      const jk = joinKey(x.snapshot_date, periodType);
      if (!m.has(label)) m.set(label, { label, jk, value: 0 });
      m.get(label).value += x.revenue_垃圾量 + x.revenue_地磅垃圾量;
    }
    return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
  };
  const curTrend = groupRows(start, end);
  const prevTrend = groupRows(trendPrevStart, trendPrevEnd);
  const prevMap = {};
  for (const r of prevTrend) prevMap[r.jk] = r2(r.value);
  const prevByIndex = prevTrend.map(r => r2(r.value));
  const trend = curTrend.map((r, i) => {
    const cv = r2(r.value);
    const pv = periodType === 'quarter' ? prevByIndex[i] : prevMap[r.jk];
    const has = pv != null && !isNaN(pv);
    return { label: r.label, value: cv, prev: has ? r2(pv) : null, yoy: has && pv !== 0 ? r1(((cv - pv) / pv) * 100) : null };
  });
  // 作业所分解
  let districtCompare = [], districtTable = [];
  if (scope === 'company') {
    const byUnit = new Map();
    for (const x of snapshot.filter(x => inRange(x.snapshot_date, start, end) && x.unit !== '')) {
      byUnit.set(x.unit, (byUnit.get(x.unit) || 0) + x.revenue_垃圾量 + x.revenue_地磅垃圾量);
    }
    const prevByUnit = new Map();
    for (const x of snapshot.filter(x => inRange(x.snapshot_date, pStart, pEnd) && x.unit !== '')) prevByUnit.set(x.unit, (prevByUnit.get(x.unit) || 0) + x.revenue_垃圾量 + x.revenue_地磅垃圾量);
    districtCompare = [...byUnit.entries()].map(([name, value]) => ({ name, value: r2(value), pct: cur.垃圾量 > 0 ? r1(value * 100 / cur.垃圾量) : 0 })).sort((a, b) => b.value - a.value);
    districtTable = districtCompare.map(d => { const chg = makeChange(d.value, prevByUnit.get(d.name), {}); return { name: d.name, value: d.value, pct: d.pct, daily: r1(d.value / daysInPeriod), change: chg.change, cls: chg.cls, hot: chg.hot }; });
  }
  const 漏收率 = r1(100 - cur.收运率), prev漏收率 = r1(100 - prev.收运率);
  const 漏收Change = makeChange(漏收率, prev漏收率, {});
  const 漏收Flip = { ...漏收Change, cls: 漏收Change.cls === 'up' ? 'down' : 漏收Change.cls === 'down' ? 'up' : 'neutral', change: 漏收Change.change.replace(/↑|↓/, m => m === '↑' ? '↓' : '↑') };
  const kpis = [
    { key: '垃圾量', label: '周期垃圾量（总计量）', value: cur.垃圾量, unit: '吨', ...makeChange(cur.垃圾量, prev.垃圾量, {}) },
    { key: '日均', label: '日均垃圾量', value: r2(cur.垃圾量 / daysInPeriod), unit: '吨/日', ...makeChange(cur.垃圾量 / daysInPeriod, prev.垃圾量 / Math.max(Math.round((new Date(pEnd) - new Date(pStart)) / 86400000) + 1, 1), {}) },
    { key: '收运覆盖率', label: '收运覆盖率', value: cur.收运率, unit: '%', ...makeChange(cur.收运率, prev.收运率, {}) },
    { key: '漏收率', label: '漏收率', value: 漏收率, unit: '%', ...漏收Flip },
    { key: '趟次', label: '周期收运趟次', value: cur.趟次, unit: '趟', ...makeChange(cur.趟次, prev.趟次, { decimals: 0 }) },
    { key: '覆盖点位', label: '覆盖点位（峰值）', value: cur.覆盖点位, unit: '个', ...makeChange(cur.覆盖点位, prev.覆盖点位, { decimals: 0 }) }
  ];
  const summary = [];
  const fmtV = v => v >= 10000 ? `${(v / 10000).toFixed(1)}万` : v.toLocaleString();
  {
    const chg = makeChange(cur.垃圾量, prev.垃圾量, {});
    let text = `垃圾量（总计量）${fmtV(cur.垃圾量)} 吨`;
    if (chg.pct !== null) text += `，同比 ${chg.pct >= 0 ? '+' : ''}${chg.pct.toFixed(1)}%`;
    text += `；日均 ${(cur.垃圾量 / daysInPeriod).toFixed(1)} 吨/日。`;
    if (scope === 'company' && districtCompare.length > 0) text += `${districtCompare[0].name} 以 ${districtCompare[0].pct}% 占比居首。`;
    summary.push({ level: 'info', text });
  }
  {
    const hotList = [];
    for (const k of kpis) if (k.hot && k.pct !== null && k.key !== '漏收率') hotList.push(`${k.label} 同比 ${k.pct >= 0 ? '+' : ''}${k.pct}%`);
    for (const d of districtTable) if (d.hot) hotList.push(`${d.name} 垃圾量同比 ${d.change.replace(/^[↑↓]\s*/, '')}`);
    if (hotList.length > 0) summary.push({ level: 'warn', text: `需关注（变化超 20%）：${hotList.slice(0, 4).join('、')}${hotList.length > 4 ? ' 等' : ''}。` });
    else summary.push({ level: 'info', text: '本期各项指标同比变化均在 20% 以内，整体运行平稳，无红色预警项。' });
  }
  const appendix = [
    `时间口径：本报告为${periodTypeLabel}（${periodLabelTxt}，${start} ~ ${end}）；同比 = 与${year - 1}年同期比较（季报趋势对比为同年上一季度）；日均 = 周期总量 ÷ ${daysInPeriod} 天。`,
    '总量口径：总垃圾量 = Σ(车辆过磅跟踪进厂量 + 地磅导入净重)；收运趟次 = 进厂车次 + 有效过磅车次。',
    '覆盖口径：收运覆盖率 = 快照收运率的区间平均（单日 = 实际收运点位 ÷ 计划点位 × 100）；漏收率 = 100% − 收运覆盖率。',
    DEMO_NOTE
  ];
  // 覆盖度诚实提示：演示数据未铺满整个周期时，周期级同比不可比
  const coveredDays = new Set(snapshot.filter(x => inRange(x.snapshot_date, start, end) && x.unit === unit).map(x => x.snapshot_date)).size;
  if (coveredDays < daysInPeriod * 0.9) {
    summary.push({ level: 'warn', text: `演示数据仅覆盖本周期 ${coveredDays}/${daysInPeriod} 天，周期级同比因覆盖天数不同不可比；请改用月报/季报或看趋势（本期 vs 同期）对比。` });
    appendix.push(`数据覆盖：本周期 ${coveredDays}/${daysInPeriod} 天有快照数据。`);
  }
  return { result: {
    demo: true,
    report: {
      meta: { org: '厦门市政环卫有限公司 · 智慧管控系统（演示数据）', scopeLabel: scope === 'company' ? '公司级' : scope, scopeDesc: scope === 'company' ? '公司 → 作业所 → 片区/班次 → 车辆/线路' : `作业所级（${scope}）`, periodTypeLabel, periodLabel: periodLabelTxt, generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }), rangeLabel: `${start} ~ ${end}`, prevRangeLabel: `${pStart} ~ ${pEnd}`, days: daysInPeriod, unitCount: districtCompare.length, dataCoverage: `${coveredDays}/${daysInPeriod} 天` },
      scope, summary,
      waste: { kpis, trend, districtPie: districtCompare.map(d => ({ name: d.name, value: d.value })), workTypePie, districtCompare, districtTable },
      appendix
    }
  } };
}

function demoWasteDetail(a) {
  const kind = a.kind;
  const { start, end, pStart, pEnd, unit } = a;
  const pS = pStart || `${Number((start || '2026-10-01').slice(0, 4)) - 1}${(start || '-10-01').slice(4)}`;
  const pE = pEnd || `${Number((end || '2026-10-13').slice(0, 4)) - 1}${(end || '-10-13').slice(4)}`;
  const { records } = loadDemoData();
  const day = ts => ts.slice(0, 10);
  const recIn = (s, e) => records.filter(x => inRange(day(x.ts), s, e) && (!unit || x.uname === unit));
  const wtDict = {};
  if (kind === 'heatmap') {
    const matrix = Array.from({ length: 7 }, () => Array(8).fill(0));
    let max = 0;
    for (const x of recIn(start, end)) {
      const d = dowIndex(day(x.ts)), slot = Math.floor(Number(x.startMin) / 60 / 3);
      if (d >= 0 && d < 7 && slot >= 0 && slot < 8) { matrix[d][slot] = r2(matrix[d][slot] + x.v); if (matrix[d][slot] > max) max = matrix[d][slot]; }
    }
    return { result: { demo: true, kind, rows: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'], cols: ['00-03点', '03-06点', '06-09点', '09-12点', '12-15点', '15-18点', '18-21点', '21-24点'], matrix, max: r2(max), unit: '吨', rangeLabel: `${start} ~ ${end}`, note: DEMO_NOTE } };
  }
  if (kind === 'category_yoy') {
    const byType = (s, e) => { const m = {}; for (const x of recIn(s, e)) { const name = wtDict[x.wt] || resolveWorkTypeName(x.wt); m[name] = r2((m[name] || 0) + x.v); } return m; };
    const cur = byType(start, end), prev = byType(pS, pE);
    const items = [...new Set([...Object.keys(cur), ...Object.keys(prev)])].map(name => { const c = cur[name] || 0, p = prev[name] || 0; return { name, current: c, prev: p, yoy: p > 0 ? r1((c - p) / p * 100) : null }; }).sort((x, y) => y.current - x.current);
    return { result: { demo: true, kind, items, unit: '吨', rangeLabel: `${start} ~ ${end}`, prevRangeLabel: `${pS} ~ ${pE}`, note: DEMO_NOTE } };
  }
  if (kind === 'shift') {
    const map = new Map();
    for (const x of recIn(start, end)) {
      const shift = shiftOfRange(x.startMin, x.endMin);
      const name = resolveWorkTypeName(x.wt);
      if (!map.has(shift)) map.set(shift, { name: shift, total: 0 });
      const it = map.get(shift);
      it[name] = r2((it[name] || 0) + x.v);
      it.total = r2(it.total + x.v);
    }
    const items = [...map.values()].sort((x, y) => shiftOrder(x.name, y.name));
    const keys = [...new Set(items.flatMap(i => Object.keys(i).filter(k => k !== 'name' && k !== 'total')))];
    return { result: { demo: true, kind, items, keys, unit: '吨', warnings: ['口径：班次窗口 = 早班 00:00–08:30 / 上午 08:30–12:00 / 下午 12:00–18:00 / 晚上 18:00–24:00，起止跨窗口归「其他」'], note: DEMO_NOTE } };
  }
  if (kind === 'unit_category') {
    const map = new Map(); const keyTotals = new Map();
    for (const x of recIn(start, end)) {
      const key = resolveWorkTypeName(x.wt);
      if (!map.has(x.uname)) map.set(x.uname, { name: x.uname, total: 0 });
      const it = map.get(x.uname);
      it[key] = r2((it[key] || 0) + x.v);
      it.total = r2(it.total + x.v);
      keyTotals.set(key, (keyTotals.get(key) || 0) + x.v);
    }
    const keys = [...keyTotals.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k);
    const items = [...map.values()].sort((x, y) => y.total - x.total);
    return { result: { demo: true, kind, keys, items, unit: '吨', warnings: [], note: DEMO_NOTE } };
  }
  if (kind === 'unit_vs_avg') {
    const byUnit = new Map(); const monthSet = new Set();
    // 公司均值必须覆盖全部作业所：用不带 unit 过滤的全量记录（与 SQL 版 WASTE_UNION_WITH_UNIT('') 口径一致）
    for (const x of records) {
      const ym = day(x.ts).slice(0, 7);
      monthSet.add(ym);
      if (!byUnit.has(x.uname)) byUnit.set(x.uname, new Map());
      byUnit.get(x.uname).set(ym, (byUnit.get(x.uname).get(ym) || 0) + x.v);
    }
    const labels = [...monthSet].sort();
    const cur = labels.map(ym => { if (unit) return r2(byUnit.get(unit)?.get(ym) || 0); let s = 0; for (const [, m] of byUnit) s += m.get(ym) || 0; return r2(s); });
    const avgArr = labels.map(ym => { let s = 0, n = 0; for (const [, m] of byUnit) { if (m.has(ym)) { s += m.get(ym); n++; } } return n ? r2(s / n) : 0; });
    return { result: { demo: true, kind, labels, cur, avg: avgArr, unitName: unit || '公司合计', unit: '吨', warnings: unit && !byUnit.has(unit) ? [`作业所「${unit}」在区间内无记录`] : [], note: DEMO_NOTE } };
  }
  throw new Error('不支持的明细类型：' + kind);
}

// 演示明细结果是否全空（用于补充窗口提示）
function detailResultIsEmpty(r) {
  if (r.kind === 'heatmap') return !r.max;
  if (r.kind === 'category_yoy' || r.kind === 'shift' || r.kind === 'unit_category') return !(r.items || []).length;
  if (r.kind === 'unit_vs_avg') return !(r.cur || []).some(v => v > 0);
  return false;
}

// ==================== 工具入口 ====================
async function executeWaste(call, root, signal) {
  if (!capabilities.includes(call.tool)) throw new Error('不支持的经营分析技能');
  signal.throwIfAborted();
  const a = call.arguments || {};
  if (call.tool === 'local_waste_status') return wasteStatus();
  if (call.tool === 'local_waste_report') return wasteReport(a, signal);
  if (call.tool === 'local_waste_detail') return wasteDetail(a, signal);
  if (call.tool === 'local_biz_configure') return bizConfigure(a);
  if (call.tool === 'local_biz_schema') return bizSchema(signal);
  if (call.tool === 'local_biz_query') return bizQuery(a, signal);
  throw new Error('不支持的经营分析技能');
}

// ---------- 通用：数据源连接配置（对话中动态切换） ----------
async function bizConfigure(a) {
  const action = normAction(a.action);
  const j = loadConnectionsFile() || { active: 'default', connections: {} };
  j.connections = j.connections || {};
  if (action === 'list') {
    const active = resolveActiveConnection();
    return { result: { action, active: active.name, connections: Object.entries(j.connections).map(([name, c]) => ({ name, host: c.host, port: c.port, database: c.database, user: c.user })), defaultSkeleton: DEFAULT_CONNECTION, hint: configHint() } };
  }
  if (action === 'set') {
    const name = (a.name || 'default').slice(0, 50);
    if (!a.host || !a.database || !a.user) throw new Error('连接信息不完整：需要 host、user、database（port 默认 3306）');
    const c = { host: String(a.host).slice(0, 100), port: Number(a.port || 3306), user: String(a.user).slice(0, 100), password: a.password === undefined ? '' : String(a.password).slice(0, 200), database: String(a.database).slice(0, 100) };
    let conn;
    try {
      conn = await mysql.createConnection({ ...c, connectTimeout: 8000 });
      const [t] = await conn.query('SELECT DATABASE() AS db');
      const [cnt] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
      j.connections[name] = c;
      j.active = name;
      saveConnectionsFile(j);
      return { result: { action, name, saved: true, active: name, database: t[0]?.db || c.database, tableCount: Number(cnt[0]?.n || 0), connectionsFile: CONFIG_FILE } };
    } catch (e) {
      return { result: { action, name, saved: false, error: `连接失败：${e.message}（请核对地址/端口/账号密码，或确认本机与数据库网络互通）` } };
    } finally { if (conn) await conn.end().catch(() => {}); }
  }
  if (action === 'activate') {
    if (!a.name || !j.connections[a.name]) throw new Error(`连接「${a.name}」不存在，现有：${Object.keys(j.connections).join('、') || '无'}`);
    j.active = a.name;
    saveConnectionsFile(j);
    return { result: { action, active: a.name } };
  }
  if (action === 'remove') {
    if (!a.name || !j.connections[a.name]) throw new Error(`连接「${a.name}」不存在`);
    delete j.connections[a.name];
    if (j.active === a.name) j.active = 'default';
    saveConnectionsFile(j);
    return { result: { action, removed: a.name, active: j.active } };
  }
  throw new Error('不支持的 action：' + action);
}

// ---------- 通用：表结构探查（任意 MySQL 库） ----------
async function bizSchema(signal) {
  const cfg = resolveActiveConnection();
  if (isDemoMode(cfg)) return { result: demoSchema() };
  if (cfg.incomplete) throw new Error(configHint());
  signal.throwIfAborted();
  const conn = await mysql.createConnection(connOpts(cfg, { connectTimeout: 8000, dateStrings: true }));
  try {
    const [tables] = await conn.execute(`SELECT TABLE_NAME AS t, TABLE_ROWS AS rows_approx, TABLE_COMMENT AS comment
      FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME LIMIT 100`);
    const [cols] = await conn.execute(`SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
      COLUMN_KEY AS k, COLUMN_COMMENT AS comment
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`);
    const byTable = {};
    for (const col of cols) { (byTable[col.t] = byTable[col.t] || []).push({ name: col.c, type: col.type, nullable: col.nullable === 'YES', key: col.k || undefined, comment: col.comment || undefined }); }
    // 抽样：优先有行数的表，最多 5 张，每张 2 行，值截断防膨胀
    const sampled = [];
    for (const t of tables.map(x => x.t).filter(x => x !== 'schema_migrations').slice(0, 5)) {
      try {
        const [rows] = await conn.execute(`SELECT * FROM \`${t}\` LIMIT 2`);
        sampled.push({ table: t, rows: rows.map(r => { const o = {}; for (const [k, v] of Object.entries(r)) o[k] = v === null ? null : String(v).slice(0, 120); return o; }) });
      } catch (e) { sampled.push({ table: t, error: e.message.slice(0, 100) }); }
    }
    return { result: {
      database: cfg.database, connection: `${cfg.host}:${cfg.port}`,
      tables: tables.map(t => ({ name: t.t, approxRows: Number(t.rows_approx || 0), comment: t.comment || undefined, columns: byTable[t.t] || [] })),
      samples: sampled,
      note: 'approxRows 为 information_schema 估算值，精确行数请用 local_biz_query 执行 SELECT COUNT(*)'
    } };
  } finally { await conn.end().catch(() => {}); }
}

// ---------- 通用：只读 SQL 分析 ----------
// 剥离字符串字面量、反引号标识符与注释后再做关键字检查：
// 既避免 WHERE action='delete' 这类合法查询被误伤，也避免关键字藏在注释/字符串里绕过检查
function stripSqlNoise(sql) {
  return String(sql || '')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(?:#|--)[^\n]*/g, ' ');
}
// 注意 load_file 必须整体匹配：下划线是单词字符，\bload\b 拦不住 LOAD_FILE(...)
const SQL_RISK_PATTERN = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|replace|rename|lock|unlock|call|handler|load_file|outfile|dumpfile|set\s+@)\b|into\s+(out|dump)file/i;
function assertReadOnlySql(sql) {
  const s = String(sql || '').trim().replace(/;+\s*$/, '');
  if (!s) throw new Error('SQL 不能为空');
  if (/;\s*\S/.test(s)) throw new Error('只允许单条 SQL 语句');
  if (!/^(select|show|desc|describe|explain|with)\b/i.test(s)) throw new Error('仅支持只读查询（SELECT / SHOW / DESC / EXPLAIN / WITH）');
  if (/\bfor\s+update\b/i.test(s)) throw new Error('不支持 FOR UPDATE');
  const hit = stripSqlNoise(s).match(SQL_RISK_PATTERN);
  if (hit) throw new Error(`SQL 包含禁止的写操作/风险关键字：${hit[0].toUpperCase().replace(/\s+/g, ' ')}；如为业务字样请调整表述`);
  return s;
}
async function bizQuery(a, signal) {
  const cfg = resolveActiveConnection();
  if (isDemoMode(cfg)) throw new Error(DEMO_NOTE + ' 演示模式不支持任意 SQL；请使用 local_waste_status / local_waste_report / local_waste_detail 分析演示数据，或先在对话中提供真实数据库连接。');
  if (cfg.incomplete) throw new Error(configHint());
  const sql = assertReadOnlySql(a.sql);
  const maxRows = Math.max(1, Math.min(Number(a.maxRows) || 200, 500));
  signal.throwIfAborted();
  const conn = await mysql.createConnection(connOpts(cfg, { connectTimeout: 8000, dateStrings: true }));
  try {
    const [rows, fields] = await conn.execute(sql);
    if (Array.isArray(rows)) {
      const truncated = rows.length > maxRows;
      return { result: { columns: (fields || []).map(f => f.name), rows: rows.slice(0, maxRows).map(r => { const o = {}; for (const [k, v] of Object.entries(r)) o[k] = v === null ? null : typeof v === 'object' ? String(v) : v; return o; }), rowCount: rows.length, truncated } };
    }
    return { result: { ok: true } }; // SHOW/DESC 等返回 OkPacket
  } finally { await conn.end().catch(() => {}); }
}

// ---------- 数据源状态（当前连接 + 快照覆盖 + 连接列表） ----------
async function wasteStatus() {
  const cfg = resolveActiveConnection();
  if (isDemoMode(cfg)) return demoStatus();
  const j = loadConnectionsFile() || { active: 'default', connections: {} };
  const out = { connection: { name: cfg.name, host: cfg.host, port: cfg.port, database: cfg.database, incomplete: cfg.incomplete }, connections: Object.keys(j.connections || {}), tableReady: false, units: [], warnings: [] };
  if (cfg.incomplete) { out.warnings.push(configHint()); return { result: out }; }
  let conn;
  try {
    conn = await mysql.createConnection(connOpts(cfg, { connectTimeout: 8000, dateStrings: true }));
    const [all] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
    out.tableCount = Number(all[0]?.n || 0);
    const [t] = await conn.query("SHOW TABLES LIKE 'biz_snapshot'");
    out.tableReady = t.length > 0;
    if (!out.tableReady) { out.warnings.push('快照表 biz_snapshot 尚未创建（原系统启动迁移会建表）'); }
    else {
      const [r] = await conn.execute(`SELECT MIN(snapshot_date) AS min_date, MAX(snapshot_date) AS max_date,
        COUNT(*) AS total_records, COUNT(DISTINCT snapshot_date) AS total_days, COUNT(DISTINCT unit) AS total_units FROM biz_snapshot`);
      const s = r[0] || {};
      out.snapshot = { minDate: s.min_date ? String(s.min_date).slice(0, 10) : null, maxDate: s.max_date ? String(s.max_date).slice(0, 10) : null, totalRecords: Number(s.total_records || 0), totalDays: Number(s.total_days || 0), totalUnits: Number(s.total_units || 0) };
      const [u] = await conn.execute("SELECT DISTINCT unit FROM biz_snapshot WHERE unit != '' ORDER BY unit");
      out.units = u.map(x => x.unit);
      const days = out.snapshot.maxDate ? Math.round((Date.now() - new Date(out.snapshot.maxDate + 'T00:00:00+08:00')) / 86400000) : null;
      if (days != null && days >= 1) out.warnings.push(`快照最新日期为 ${out.snapshot.maxDate}（距今 ${days} 天），今日数据需每日 12:00 定时回填`);
    }
  } catch (e) { out.warnings.push('当前连接失败：' + e.message + '；' + configHint()); }
  finally { if (conn) await conn.end().catch(() => {}); }
  return { result: out };
}

// ---------- 经营分析报告（垃圾量域，移植 /report/generate 2224-2788） ----------
async function wasteReport(a, signal) {
  const snapCfg = resolveActiveConnection();
  if (isDemoMode(snapCfg)) return demoWasteReport(a);
  if (snapCfg.incomplete) throw new Error(configHint());
  const { scope, periodType, year, quarter, month, start, end, pStart, pEnd } = resolvePeriod(a);
  const unit = scope === 'company' ? '' : scope;
  const periodTypeLabel = periodType === 'year' ? '年报' : periodType === 'quarter' ? '季报' : '月报';
  const periodLabel = periodType === 'year' ? `${year}年` : periodType === 'quarter' ? `${year}年第${quarter}季度` : `${year}年${month}月`;
  const daysInPeriod = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
  // 趋势对比区间：月报→去年同月；季报→同年上一季度（Q1 取去年 Q4）；年报→去年全年
  let trendPrevStart = pStart, trendPrevEnd = pEnd;
  if (periodType === 'quarter') {
    if (quarter > 1) { const pm = (quarter - 2) * 3 + 1; trendPrevStart = `${year}-${pad2(pm)}-01`; trendPrevEnd = `${year}-${pad2(pm + 2)}-${pad2(lastDayOfMonth(year, pm + 2))}`; }
    else { trendPrevStart = `${year - 1}-10-01`; trendPrevEnd = `${year - 1}-12-31`; }
  }
  signal.throwIfAborted();
  const conn = await mysql.createConnection(connOpts(snapCfg, { connectTimeout: 8000, dateStrings: true }));
  try {
    if (unit) {
      const [units] = await conn.execute(`SELECT DISTINCT unit FROM biz_snapshot WHERE unit != '' ORDER BY unit`);
      if (!units.some(r => r.unit === unit)) throw new Error(`数据库中不存在作业所「${unit}」；可用作业所：${units.map(r => r.unit).join('、') || '（快照表无作业所数据）'}`);
    }
    const WASTE_SUM = 'COALESCE(ROUND(SUM(revenue_垃圾量) + COALESCE(SUM(revenue_地磅垃圾量), 0), 2), 0)';
    const aggRange = async (s, e) => {
      const [r] = await conn.execute(`
        SELECT ${WASTE_SUM} AS 垃圾量, COALESCE(SUM(revenue_趟次), 0) AS 趟次,
               COALESCE(MAX(revenue_覆盖点位), 0) AS 覆盖点位,
               COALESCE(ROUND(AVG(revenue_收运率), 1), 0) AS 收运率
        FROM biz_snapshot WHERE snapshot_date BETWEEN ? AND ? AND unit = ?`, [s, e, unit]);
      return { 垃圾量: parseFloat(r[0]?.垃圾量 || 0), 趟次: parseInt(r[0]?.趟次 || 0, 10), 覆盖点位: parseInt(r[0]?.覆盖点位 || 0, 10), 收运率: parseFloat(r[0]?.收运率 || 0) };
    };
    const cur = await aggRange(start, end);
    const prev = await aggRange(pStart, pEnd);

    // 分类结构（JSON 列逐日累加；公司级聚合所有作业所行，aggregateWorkType 2345-2388 同口径）
    const unitOp = unit ? '=' : '!=';
    const [wtRows] = await conn.execute(`SELECT revenue_作业类型分布 AS j FROM biz_snapshot
      WHERE snapshot_date BETWEEN ? AND ? AND unit ${unitOp} ?`, [start, end, unit || '']);
    const wtAcc = { '可回收物': 0, '有害垃圾': 0, '厨余垃圾': 0, '其他垃圾': 0 };
    for (const r of wtRows) {
      try { const obj = JSON.parse(r.j || '{}'); for (const [k, v] of Object.entries(obj)) { const name = resolveWorkTypeName(k); wtAcc[name] = (wtAcc[name] || 0) + parseFloat(v || 0); } } catch { /* 忽略损坏 JSON */ }
    }
    const workTypePie = Object.entries(wtAcc).filter(([, value]) => value > 0).map(([name, value]) => ({ name, value: parseFloat(value.toFixed(2)) })).sort((x, y) => y.value - x.value);

    // 趋势（月报按日、季/年报按月；对位键=年内相对位置；季报按序号对位 2429-2468）
    const groupFmt = periodType === 'month' ? '%Y-%m-%d' : '%Y-%m';
    const joinFmt = periodType === 'month' ? '%m-%d' : '%m';
    const trendQ = async (s, e) => (await conn.execute(`
      SELECT DATE_FORMAT(snapshot_date, '${groupFmt}') AS 周期, DATE_FORMAT(snapshot_date, '${joinFmt}') AS 对位,
             ${WASTE_SUM} AS 垃圾量
      FROM biz_snapshot WHERE snapshot_date BETWEEN ? AND ? AND unit = ? GROUP BY 周期, 对位 ORDER BY 周期`, [s, e, unit || '']))[0];
    const curTrend = await trendQ(start, end);
    const prevTrend = await trendQ(trendPrevStart, trendPrevEnd);
    const prevMap = {};
    for (const r of prevTrend) prevMap[r.对位] = parseFloat(r.垃圾量);
    const prevByIndex = prevTrend.map(r => parseFloat(r.垃圾量));
    const trend = curTrend.map((r, i) => {
      const cv = parseFloat(r.垃圾量);
      const pv = periodType === 'quarter' ? prevByIndex[i] : prevMap[r.对位];
      const has = pv != null && !isNaN(pv);
      return { label: r.周期, value: cv, prev: has ? parseFloat(pv.toFixed(2)) : null, yoy: has && pv !== 0 ? parseFloat((((cv - pv) / pv) * 100).toFixed(1)) : null };
    });

    // 作业所分解（公司级视角）
    let districtCompare = [], districtTable = [];
    const totalGarbage = cur.垃圾量;
    if (scope === 'company') {
      const [distCur] = await conn.execute(`SELECT unit AS 区域, ${WASTE_SUM} AS 垃圾量 FROM biz_snapshot
        WHERE snapshot_date BETWEEN ? AND ? AND unit != '' GROUP BY unit ORDER BY 垃圾量 DESC`, [start, end]);
      const [distPrev] = await conn.execute(`SELECT unit AS 区域, ${WASTE_SUM} AS 垃圾量 FROM biz_snapshot
        WHERE snapshot_date BETWEEN ? AND ? AND unit != '' GROUP BY unit`, [pStart, pEnd]);
      const prevMap2 = {};
      for (const r of distPrev) prevMap2[r.区域] = parseFloat(r.垃圾量);
      districtCompare = distCur.map(r => { const value = parseFloat(r.垃圾量); return { name: r.区域, value, pct: totalGarbage > 0 ? parseFloat((value * 100 / totalGarbage).toFixed(1)) : 0 }; });
      districtTable = distCur.map(r => { const value = parseFloat(r.垃圾量); const chg = makeChange(value, prevMap2[r.区域], {});
        return { name: r.区域, value, pct: totalGarbage > 0 ? parseFloat((value * 100 / totalGarbage).toFixed(1)) : 0, daily: parseFloat((value / daysInPeriod).toFixed(1)), change: chg.change, cls: chg.cls, hot: chg.hot }; });
    }

    // KPI（垃圾量域 4+1 项：总量/日均/趟次/覆盖点位/收运覆盖率 + 漏收率衍生）
    const漏收率 = Math.round((100 - cur.收运率) * 10) / 10;
    const prev漏收率 = Math.round((100 - prev.收运率) * 10) / 10;
    const漏收Change = makeChange(漏收率, prev漏收率, {});
    // 漏收率方向取反：覆盖率下降=漏收上升
    const漏收Flip = { ...漏收Change, cls: 漏收Change.cls === 'up' ? 'down' : 漏收Change.cls === 'down' ? 'up' : 'neutral', change: 漏收Change.change.replace(/↑|↓/, m => m === '↑' ? '↓' : '↑') };
    const kpis = [
      { key: '垃圾量', label: '周期垃圾量（总计量）', value: cur.垃圾量, unit: '吨', ...makeChange(cur.垃圾量, prev.垃圾量, {}) },
      { key: '日均', label: '日均垃圾量', value: parseFloat((cur.垃圾量 / daysInPeriod).toFixed(2)), unit: '吨/日',
        ...makeChange(cur.垃圾量 / daysInPeriod, prev.垃圾量 / Math.max(Math.round((new Date(pEnd) - new Date(pStart)) / 86400000) + 1, 1), {}) },
      { key: '收运覆盖率', label: '收运覆盖率', value: cur.收运率, unit: '%', ...makeChange(cur.收运率, prev.收运率, {}) },
      { key: '漏收率', label: '漏收率', value: 漏收率, unit: '%', ...漏收Flip },
      { key: '趟次', label: '周期收运趟次', value: cur.趟次, unit: '趟', ...makeChange(cur.趟次, prev.趟次, { decimals: 0 }) },
      { key: '覆盖点位', label: '覆盖点位（峰值）', value: cur.覆盖点位, unit: '个', ...makeChange(cur.覆盖点位, prev.覆盖点位, { decimals: 0 }) }
    ];

    // 摘要（营收域，2665-2683 同口径）
    const summary = [];
    const fmtV = v => v >= 10000 ? `${(v / 10000).toFixed(1)}万` : v.toLocaleString();
    {
      const chg = makeChange(cur.垃圾量, prev.垃圾量, {});
      let text = `垃圾量（总计量）${fmtV(cur.垃圾量)} 吨`;
      if (chg.pct !== null) text += `，同比 ${chg.pct >= 0 ? '+' : ''}${chg.pct.toFixed(1)}%`;
      text += `；日均 ${(cur.垃圾量 / daysInPeriod).toFixed(1)} 吨/日。`;
      if (scope === 'company' && districtCompare.length > 0) text += `${districtCompare[0].name} 以 ${districtCompare[0].pct}% 占比居首。`;
      summary.push({ level: 'info', text });
    }
    {
      const hotList = [];
      for (const k of kpis) if (k.hot && k.pct !== null && k.key !== '漏收率') hotList.push(`${k.label} 同比 ${k.pct >= 0 ? '+' : ''}${k.pct}%`);
      for (const d of districtTable) if (d.hot) hotList.push(`${d.name} 垃圾量同比 ${d.change.replace(/^[↑↓]\s*/, '')}`);
      if (hotList.length > 0) summary.push({ level: 'warn', text: `需关注（变化超 20%）：${hotList.slice(0, 4).join('、')}${hotList.length > 4 ? ' 等' : ''}。` });
      else summary.push({ level: 'info', text: '本期各项指标同比变化均在 20% 以内，整体运行平稳，无红色预警项。' });
    }
    const appendix = [
      `时间口径：本报告为${periodTypeLabel}（${periodLabel}，${start} ~ ${end}）；同比 = 与${year - 1}年同期比较（季报趋势对比为同年上一季度）；日均 = 周期总量 ÷ ${daysInPeriod} 天。`,
      '总量口径：总垃圾量 = Σ(revenue_垃圾量 车辆过磅跟踪 gb_garbage_fill 进场量 + revenue_地磅垃圾量 地磅导入 gb_weighbridge.suttle)；收运趟次 = 进厂车次 + 有效过磅车次。',
      '覆盖口径：收运覆盖率 = 快照收运率的区间平均（单日 = 实际收运点位 ÷ 计划点位 × 100）；漏收率 = 100% − 收运覆盖率。',
      '生成机制：每日 12:00 定时从第三方业务库（yh_onepas_uat）生成快照，报告由快照表 biz_snapshot 按周期聚合生成，可下钻至各月 / 作业所明细。'
    ];
    return { result: {
      report: {
        meta: { org: '厦门市政环卫有限公司 · 智慧管控系统', scopeLabel: scope === 'company' ? '公司级' : scope, scopeDesc: scope === 'company' ? '公司 → 作业所 → 片区/班次 → 车辆/线路' : `作业所级（${scope}）`, periodTypeLabel, periodLabel, generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }), rangeLabel: `${start} ~ ${end}`, prevRangeLabel: `${pStart} ~ ${pEnd}`, days: daysInPeriod, unitCount: districtCompare.length },
        scope, summary,
        waste: { kpis, trend, districtPie: districtCompare.map(d => ({ name: d.name, value: d.value })), workTypePie, districtCompare, districtTable },
        appendix
      }
    } };
  } finally { await conn.end().catch(() => {}); }
}

// ---------- 明细分析（第三方业务库，移植 5 个明细接口） ----------
const WASTE_UNION_SQL = (extraSelect) => `
  SELECT f.fill_time AS ts, COALESCE(f.work_type, '') AS wt, f.fill_num AS v
  FROM gb_garbage_fill f
  LEFT JOIN ss_useunit u ON u.id = f.useunit_id
  WHERE DATE(f.fill_time) BETWEEN ? AND ? AND f.fill_num IS NOT NULL {{UNIT}}
  UNION ALL
  SELECT w.weight_time AS ts, COALESCE(w.work_type, '') AS wt, w.suttle AS v
  FROM gb_weighbridge w
  LEFT JOIN ss_useunit u ON u.id = w.useunit_id
  WHERE DATE(w.weight_time) BETWEEN ? AND ? AND w.suttle IS NOT NULL AND w.status = '1' {{UNIT}}
  ${extraSelect || ''}
`;
const WASTE_UNION_WITH_UNIT = (unitWhere) => `
  SELECT u.name AS uname, f.fill_time AS ts, COALESCE(f.work_type, '') AS wt, f.fill_num AS v
  FROM gb_garbage_fill f
  LEFT JOIN ss_useunit u ON u.id = f.useunit_id
  WHERE DATE(f.fill_time) BETWEEN ? AND ? AND f.fill_num IS NOT NULL ${unitWhere}
  UNION ALL
  SELECT u.name AS uname, w.weight_time AS ts, COALESCE(w.work_type, '') AS wt, w.suttle AS v
  FROM gb_weighbridge w
  LEFT JOIN ss_useunit u ON u.id = w.useunit_id
  WHERE DATE(w.weight_time) BETWEEN ? AND ? AND w.suttle IS NOT NULL AND w.status = '1' ${unitWhere}
`;
function wasteUnionParams(start, end, unit) {
  const base = [start || '1970-01-01', end || '9999-12-31'];
  return unit ? [...base, unit, ...base, unit] : [...base, ...base];
}
function dateFilter(dateExpr, start, end) {
  const s = start || '1900-01-01';
  if (!end || end >= '9999-12-31') return { cond: `AND ${dateExpr} >= ?`, params: [s] };
  return { cond: `AND ${dateExpr} >= ? AND ${dateExpr} < DATE_ADD(?, INTERVAL 1 DAY)`, params: [s, end] };
}
const SHIFT_WINDOWS = [
  { name: '早班', from: 0, to: 510 }, { name: '上午', from: 510, to: 720 },
  { name: '下午', from: 720, to: 1080 }, { name: '晚上', from: 1080, to: 1440 }
];
const SHIFT_NAMES = ['早班', '上午', '下午', '晚上', '其他'];
function shiftWindowOf(minuteOfDay) {
  const m = Number(minuteOfDay);
  if (!Number.isFinite(m)) return '其他';
  const hit = SHIFT_WINDOWS.find(w => m >= w.from && m < w.to);
  return hit ? hit.name : '其他';
}
function shiftOfRange(startMin, endMin) {
  const a = shiftWindowOf(startMin);
  const b = Number.isFinite(Number(endMin)) ? shiftWindowOf(endMin) : a;
  return a === b ? a : '其他';
}
const shiftOrder = (a, b) => {
  const ia = SHIFT_NAMES.indexOf(a) < 0 ? 99 : SHIFT_NAMES.indexOf(a);
  const ib = SHIFT_NAMES.indexOf(b) < 0 ? 99 : SHIFT_NAMES.indexOf(b);
  return ia - ib;
};

async function wasteDetail(a, signal) {
  const bizCfg = resolveActiveConnection();
  a = { ...a, kind: normKind(a.kind) };
  if (isDemoMode(bizCfg)) {
    const out = demoWasteDetail(a);
    // 演示收运记录仅覆盖两个 13 天窗口，区间外查询全空时明确提示，避免空图被当成结论
    if (detailResultIsEmpty(out.result) && !(out.result.warnings || []).length) {
      out.result.warnings = ['演示收运记录仅覆盖 2025-10-01 ~ 2025-10-13 与 2026-10-01 ~ 2026-10-13 两个 13 天窗口，当前区间无数据'];
    }
    return out;
  }
  if (bizCfg.incomplete) throw new Error(configHint() + '（垃圾量明细需连接含 gb_garbage_fill / gb_weighbridge 等业务表的数据库）');
  const kind = a.kind;
  const { start, end, pStart, pEnd, unit } = a;
  const pS = pStart || `${Number((start || '2026-01-01').slice(0, 4)) - 1}${(start || '-01-01').slice(4)}`;
  const pE = pEnd || `${Number((end || '2026-12-31').slice(0, 4)) - 1}${(end || '-12-31').slice(4)}`;
  signal.throwIfAborted();
  const conn = await mysql.createConnection(connOpts(bizCfg, { connectTimeout: 8000, dateStrings: true }));
  try {
    if (kind === 'heatmap') {
      const unitWhere = unit ? 'AND u.name = ?' : '';
      const sql = WASTE_UNION_SQL('').replace(/\{\{UNIT\}\}/g, unitWhere);
      const [rows] = await conn.execute(`
        SELECT WEEKDAY(t.ts) AS dow, FLOOR(HOUR(t.ts) / 3) AS slot, ROUND(SUM(t.v), 2) AS v
        FROM (${sql}) t GROUP BY dow, slot`, wasteUnionParams(start, end, unit));
      const DOW = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
      const SLOTS = ['00-03点', '03-06点', '06-09点', '09-12点', '12-15点', '15-18点', '18-21点', '21-24点'];
      const matrix = DOW.map(() => SLOTS.map(() => 0));
      let max = 0;
      for (const r of rows) { const d = Number(r.dow), s = Number(r.slot); if (d >= 0 && d < 7 && s >= 0 && s < 8) { const v = Number(r.v) || 0; matrix[d][s] = Math.round(v * 100) / 100; if (v > max) max = v; } }
      return { result: { kind, rows: DOW, cols: SLOTS, matrix, max: Math.round(max * 100) / 100, unit: '吨', rangeLabel: `${start} ~ ${end}` } };
    }
    if (kind === 'category_yoy') {
      const unitWhere = unit ? 'AND u.name = ?' : '';
      const sql = WASTE_UNION_SQL('').replace(/\{\{UNIT\}\}/g, unitWhere);
      const wtDict = await loadDict(conn, 'VH_PROJECT_TYPE');
      const queryByType = async (s, e) => {
        const [rows] = await conn.execute(`SELECT t.wt AS wt, ROUND(SUM(t.v), 2) AS v FROM (${sql}) t GROUP BY t.wt`, wasteUnionParams(s, e, unit));
        const m = {};
        for (const r of rows) { const name = wtDict[String(r.wt)] || resolveWorkTypeName(r.wt); m[name] = Math.round(((m[name] || 0) + Number(r.v || 0)) * 100) / 100; }
        return m;
      };
      const cur = await queryByType(start, end);
      const prev = await queryByType(pS, pE);
      const names = Array.from(new Set([...Object.keys(cur), ...Object.keys(prev)]));
      const items = names.map(name => { const c = cur[name] || 0, p = prev[name] || 0; return { name, current: c, prev: p, yoy: p > 0 ? Math.round(((c - p) / p) * 1000) / 10 : null }; }).sort((x, y) => y.current - x.current);
      return { result: { kind, items, unit: '吨', rangeLabel: `${start} ~ ${end}`, prevRangeLabel: `${pS} ~ ${pE}` } };
    }
    if (kind === 'shift') {
      const warnings = [];
      const map = new Map(); const keys = new Set();
      const bump = (shift, name, v) => { keys.add(name); if (!map.has(shift)) map.set(shift, { name: shift, total: 0 }); const it = map.get(shift); it[name] = Math.round(((it[name] || 0) + v) * 100) / 100; it.total = Math.round((it.total + v) * 100) / 100; };
      let usedTask = false;
      try {
        const u = { join: 'LEFT JOIN ss_useunit u ON u.id = ct.useunit_id', cond: unit ? 'AND u.name = ?' : '', params: unit ? [unit] : [] };
        const d = dateFilter('ct.task_date', start, end);
        const [rows] = await conn.execute(`
          SELECT (HOUR(ct.start_time) * 60 + MINUTE(ct.start_time)) AS sm,
                 (HOUR(ct.end_time) * 60 + MINUTE(ct.end_time)) AS em,
                 COALESCE(ct.work_type, '') AS wt, ROUND(SUM(COALESCE(ct.reality_weight, 0)), 2) AS v
          FROM gb_collection_task ct ${u.join}
          WHERE 1=1 ${d.cond} ${u.cond} GROUP BY sm, em, wt`, [...d.params, ...u.params]);
        for (const r of rows) bump(shiftOfRange(r.sm, r.em), resolveWorkTypeName(r.wt), Number(r.v || 0));
        usedTask = map.size > 0;
        warnings.push('口径：班次窗口 = 早班 00:00–08:30 / 上午 08:30–12:00 / 下午 12:00–18:00 / 晚上 18:00–24:00，起止跨窗口归「其他」；垃圾量 = Σreality_weight（收运任务）');
      } catch (e) { warnings.push('班次（任务口径）查询失败：' + e.message); }
      if (!usedTask) {
        try {
          const unitWhere = unit ? 'AND u.name = ?' : '';
          const sql = WASTE_UNION_WITH_UNIT(unitWhere);
          const [rows] = await conn.execute(`
            SELECT (HOUR(t.ts) * 60 + MINUTE(t.ts)) AS m, t.wt AS wt, ROUND(SUM(t.v), 2) AS v
            FROM (${sql}) t GROUP BY m, wt`, wasteUnionParams(start, end, unit));
          for (const r of rows) bump(shiftWindowOf(r.m), resolveWorkTypeName(r.wt), Number(r.v || 0));
          warnings.push('回退口径：按地磅/填报的时间点判班次');
        } catch (e) { warnings.push('班次（地磅口径）查询失败：' + e.message); }
      }
      const items = Array.from(map.values()).sort((x, y) => shiftOrder(x.name, y.name));
      return { result: { kind, items, keys: Array.from(keys), unit: '吨', warnings: Array.from(new Set(warnings)) } };
    }
    if (kind === 'unit_category') {
      const unitWhere = unit ? 'AND u.name = ?' : '';
      const sql = WASTE_UNION_WITH_UNIT(unitWhere);
      const [rows] = await conn.execute(`
        SELECT COALESCE(t.uname, '未知作业所') AS uname, COALESCE(t.wt, '') AS wt, ROUND(SUM(t.v), 2) AS v
        FROM (${sql}) t GROUP BY uname, wt`, wasteUnionParams(start, end, unit));
      const wtDict = await loadDict(conn, 'VH_PROJECT_TYPE');
      const map = new Map(); const keyTotals = new Map();
      for (const r of rows) {
        const uname = String(r.uname || '未知作业所');
        const raw = String(r.wt || '');
        const key = raw === '' ? '未标注' : (wtDict[raw] || resolveWorkTypeName(raw));
        const v = Number(r.v || 0);
        if (!v) continue;
        if (!map.has(uname)) map.set(uname, { name: uname, total: 0 });
        const it = map.get(uname);
        it[key] = Math.round(((it[key] || 0) + v) * 100) / 100;
        it.total = Math.round((it.total + v) * 100) / 100;
        keyTotals.set(key, (keyTotals.get(key) || 0) + v);
      }
      const keys = Array.from(keyTotals.entries()).sort((x, y) => y[1] - x[1]).map(([k]) => k);
      const items = Array.from(map.values()).sort((x, y) => y.total - x.total);
      const warnings = [];
      if (items.length === 0) warnings.push('区间内未取到数据（检查 gb_garbage_fill / gb_weighbridge 在所选区间的数据）');
      else if (keys.length <= 1) warnings.push(`只取到 ${keys.length} 个垃圾类型，堆叠柱只有一层`);
      return { result: { kind, keys, items, unit: '吨', warnings } };
    }
    if (kind === 'unit_vs_avg') {
      const sql = WASTE_UNION_WITH_UNIT('');
      const base = [start || '1970-01-01', end || '9999-12-31'];
      const [rows] = await conn.execute(`
        SELECT COALESCE(t.uname, '未知作业所') AS uname, DATE_FORMAT(t.ts, '%Y-%m') AS ym, ROUND(SUM(t.v), 2) AS v
        FROM (${sql}) t GROUP BY uname, ym`, [...base, ...base]);
      const monthSet = new Set(); const byUnit = new Map();
      for (const r of rows) {
        const ym = String(r.ym || '');
        if (!ym) continue;
        monthSet.add(ym);
        if (!byUnit.has(r.uname)) byUnit.set(r.uname, new Map());
        byUnit.get(r.uname).set(ym, Number(r.v || 0));
      }
      const labels = Array.from(monthSet).sort();
      const avg = labels.map(ym => { let sum = 0, n = 0; for (const [, m] of byUnit) { if (m.has(ym)) { sum += m.get(ym); n += 1; } } return n > 0 ? Math.round((sum / n) * 100) / 100 : 0; });
      const cur = labels.map(ym => { if (unit) return Number(byUnit.get(unit)?.get(ym) || 0); let sum = 0; for (const [, m] of byUnit) sum += Number(m.get(ym) || 0); return Math.round(sum * 100) / 100; });
      return { result: { kind, labels, cur, avg, unitName: unit || '公司合计', unit: '吨', warnings: unit && !byUnit.has(unit) ? [`作业所「${unit}」在区间内无垃圾量记录`] : [] } };
    }
    throw new Error('不支持的明细类型：' + kind);
  } finally { await conn.end().catch(() => {}); }
}

module.exports = { executeWaste, capabilities, assertReadOnlySql };
