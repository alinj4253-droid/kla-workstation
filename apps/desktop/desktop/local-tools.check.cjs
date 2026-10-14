const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { executeLocal, capabilities } = require('./local-tools.cjs');

test('local file skills write, read, and list actual files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kla-local-tools-'));
  const base = { id: randomUUID(), runId: randomUUID(), stepId: randomUUID() };
  try {
    const target = path.join(root, 'result.py');
    const written = await executeLocal({ ...base, tool: 'local_code', arguments: { fileName: 'result.py', path: target, content: 'print(42)\n' } }, root, new AbortController().signal);
    assert.equal(written.result.stored, true);
    assert.equal(written.result.uploaded, true);
    assert.match(written.result.checksum, /^[a-f0-9]{64}$/);
    assert.equal(written.artifact.fileName, 'result.py');
    assert.equal(await fs.readFile(target, 'utf8'), 'print(42)\n');
    const read = await executeLocal({ ...base, tool: 'local_read', arguments: { path: target } }, root, new AbortController().signal);
    assert.equal(read.result.content, 'print(42)\n');
    const writtenText = await executeLocal({ ...base, tool: 'local_write', arguments: { fileName: 'notes.md', content: '# Verified\n' } }, root, new AbortController().signal);
    assert.equal(writtenText.result.stored, true);
    assert.equal(await fs.readFile(path.join(root, 'runs', base.runId, base.stepId, base.id, 'output', 'notes.md'), 'utf8'), '# Verified\n');
    const listed = await executeLocal({ ...base, tool: 'local_list', arguments: { path: root } }, root, new AbortController().signal);
    assert.ok(listed.result.entries.some(entry => entry.name === 'result.py'));
    await assert.rejects(executeLocal({ ...base, tool: 'local_write', arguments: { fileName: '../escape.txt', content: 'bad' } }, root, new AbortController().signal), /文件名无效/);
    await assert.rejects(executeLocal({ ...base, tool: 'local_read', arguments: { path: __filename } }, root, new AbortController().signal), /允许目录/);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'kla-outside-'));
    try {
      const approvedFile = path.join(outside, 'approved.txt');
      await fs.writeFile(approvedFile, 'approved content', 'utf8');
      const readApproved = await executeLocal({ ...base, tool: 'local_read', arguments: { path: approvedFile } }, root, new AbortController().signal, true);
      assert.equal(readApproved.result.content, 'approved content');
      const listApproved = await executeLocal({ ...base, tool: 'local_list', arguments: { path: outside } }, root, new AbortController().signal, true);
      assert.ok(listApproved.result.entries.some(entry => entry.name === 'approved.txt'));
      await assert.rejects(executeLocal({ ...base, tool: 'local_write', arguments: { fileName: 'blocked.txt', path: path.join(outside, 'blocked.txt'), content: 'bad' } }, root, new AbortController().signal, true), /允许目录/);
      await fs.symlink(path.join(outside, 'redirect.py'), path.join(root, 'redirect.py'));
      await assert.rejects(executeLocal({ ...base, tool: 'local_code', arguments: { fileName: 'redirect.py', path: path.join(root, 'redirect.py'), content: 'bad' } }, root, new AbortController().signal), /允许目录|符号链接/);
      const linkedFile = path.join(outside, 'linked.txt');
      await fs.symlink(approvedFile, linkedFile);
      await assert.rejects(executeLocal({ ...base, tool: 'local_read', arguments: { path: linkedFile } }, root, new AbortController().signal, true), /符号链接/);
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('local CLI reports command output and can be cancelled', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kla-local-cli-'));
  const base = { id: randomUUID(), runId: randomUUID(), stepId: randomUUID(), tool: 'local_cli' };
  try {
    const answer = await executeLocal({ ...base, arguments: { executable: process.execPath, args: ['-e', 'process.stdout.write("ready")'] } }, root, new AbortController().signal);
    assert.equal(answer.result.stdout, 'ready');
    const controller = new AbortController();
    const running = executeLocal({ ...base, arguments: { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 10000 } }, root, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(running, /取消/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('local BAT executes a command on Windows', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kla-local-bat-'));
  try {
    const call = { id: randomUUID(), runId: randomUUID(), stepId: randomUUID(), tool: 'local_bat', arguments: { script: 'echo KLA_BAT_OK' } };
    const result = await executeLocal(call, root, new AbortController().signal);
    assert.equal(result.result.exitCode, 0);
    assert.match(result.result.stdout, /KLA_BAT_OK/);
    assert.match(result.result.workingDirectory, /^workspace:\/\//);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('shared input downloads into an isolated workspace and CLI output can be explicitly published', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kla-shared-local-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'kla-private-local-'));
  const signal = new AbortController().signal;
  const base = { runId: randomUUID(), stepId: randomUUID() };
  const call = (tool, args) => ({ ...base, id: randomUUID(), tool, arguments: args });
  try {
    const input = Buffer.from('shared source\n');
    const fetched = await executeLocal(call('local_file_fetch', { fileId: randomUUID() }), root, signal, false, async () => ({ name: 'input.txt', bytes: input }));
    assert.match(fetched.result.path, /^workspace:\/\/runs\//);
    const read = await executeLocal(call('local_read', { path: fetched.result.path }), root, signal);
    assert.equal(read.result.content, input.toString());
    const output = await executeLocal(call('local_cli', { executable: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("report.pdf", Buffer.from("%PDF-1.4 test"))'] }), root, signal);
    assert.equal(output.result.exitCode, 0);
    const published = await executeLocal(call('local_file_publish', { path: output.result.workingDirectory + '/report.pdf' }), root, signal);
    assert.equal(published.artifact.mimeType, 'application/pdf');
    assert.equal(published.artifact.contentEncoding, 'base64');
    assert.equal(Buffer.from(published.artifact.content, 'base64').toString(), '%PDF-1.4 test');
    const privatePath = path.join(outside, 'private.txt');
    await fs.writeFile(privatePath, 'private');
    await assert.rejects(executeLocal(call('local_file_publish', { path: privatePath }), root, signal), /允许目录/);
    assert.equal((await executeLocal(call('local_file_publish', { path: privatePath }), root, signal, true)).artifact.content, 'private');
    await assert.rejects(executeLocal(call('local_read', { path: 'workspace://../private.txt' }), root, signal), /越界/);
    await assert.rejects(executeLocal(call('local_file_fetch', { fileId: randomUUID() }), root, signal, false, async () => ({ name: '../escape.txt', bytes: input })), /文件名/);
    const prior = process.env.KLA_LOCAL_ARTIFACT_UPLOAD;
    try {
      process.env.KLA_LOCAL_ARTIFACT_UPLOAD = 'false';
      const localOnly = await executeLocal(call('local_file_publish', { path: fetched.result.path }), root, signal);
      assert.equal(localOnly.result.localOnly, true);
      assert.equal(localOnly.artifact, undefined);
    } finally { if (prior === undefined) delete process.env.KLA_LOCAL_ARTIFACT_UPLOAD; else process.env.KLA_LOCAL_ARTIFACT_UPLOAD = prior; }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

// ==================== 经营分析（演示数据模式，不连库） ====================
const { executeWaste, assertReadOnlySql } = require('./local-waste.cjs');

const wasteCall = (tool, args) => ({ id: randomUUID(), runId: randomUUID(), stepId: randomUUID(), tool, arguments: args });
const runWaste = (tool, args) => executeWaste(wasteCall(tool, args), os.tmpdir(), new AbortController().signal);

test('waste demo mode reports data source status without a database', async () => {
  delete process.env.KLA_BIZ_DB_USER;
  delete process.env.KLA_BIZ_DB_PASSWORD;
  const { result } = await runWaste('local_waste_status', {});
  assert.equal(result.mode, 'demo');
  assert.equal(result.snapshot.totalDays, 651);
  assert.equal(result.snapshot.minDate, '2025-01-01');
  assert.equal(result.snapshot.maxDate, '2026-10-13');
  assert.deepEqual(result.units, ['湖里环卫所', '集美环卫所']);
  assert.equal(result.recordsWindow, '2025-10-01 ~ 2026-10-13');
});

test('waste demo report aggregates KPI, trend and coverage honesty', async () => {
  const { result } = await runWaste('local_waste_report', { scope: 'company', periodType: 'year', year: 2026 });
  assert.equal(result.demo, true);
  assert.equal(result.report.meta.periodLabel, '2026年');
  assert.equal(result.report.meta.dataCoverage, '286/365 天');
  const kpi = result.report.waste.kpis.find(k => k.key === '垃圾量');
  assert.ok(Number.isFinite(kpi.value) && kpi.value > 0, '垃圾量 KPI 应为正有限数');
  assert.match(result.report.summary.map(s => s.text).join('\n'), /演示数据仅覆盖本周期/);
  // 分类结构不含 0 值扇区
  assert.ok(result.report.waste.workTypePie.every(p => p.value > 0), 'pie 不应含 0 值类目');
});

test('waste demo report rejects unknown unit instead of an all-zero report', async () => {
  await assert.rejects(runWaste('local_waste_report', { scope: '思明环卫所', periodType: 'year', year: 2026 }), /不存在作业所「思明环卫所」；可用作业所：湖里环卫所、集美环卫所/);
});

test('waste demo report covers unit-level quarter', async () => {
  const { result } = await runWaste('local_waste_report', { scope: '集美环卫所', periodType: 'quarter', year: 2026, quarter: 2 });
  assert.equal(result.report.meta.periodLabel, '2026年第2季度');
  assert.equal(result.report.meta.dataCoverage, '91/91 天');
  assert.equal(result.report.meta.unitCount, 0);
});

test('waste demo detail returns data for all five kinds', async () => {
  const heatmap = (await runWaste('local_waste_detail', { kind: 'heatmap', start: '2026-10-01', end: '2026-10-13' })).result;
  assert.equal(heatmap.rows.length, 7);
  assert.equal(heatmap.cols.length, 8);
  assert.ok(heatmap.max > 0, '演示窗口内热力图应有峰值');
  const yoy = (await runWaste('local_waste_detail', { kind: 'category_yoy', start: '2026-10-01', end: '2026-10-13', pStart: '2025-10-01', pEnd: '2025-10-13' })).result;
  assert.ok(yoy.items.length >= 2, '分类同比应有多个类目');
  const shift = (await runWaste('local_waste_detail', { kind: 'shift', start: '2026-10-01', end: '2026-10-13' })).result;
  assert.equal(shift.items[0].name, '早班', '班次应按早班开头排序');
  const unitCat = (await runWaste('local_waste_detail', { kind: 'unit_category', start: '2026-10-01', end: '2026-10-13' })).result;
  assert.deepEqual(unitCat.items.map(i => i.name).sort(), ['湖里环卫所', '集美环卫所']);
  const vsAvg = (await runWaste('local_waste_detail', { kind: 'unit_vs_avg', start: '2026-10-01', end: '2026-10-13', unit: '湖里环卫所' })).result;
  // 公司均值必须覆盖全部作业所，不能恒等于本所值
  assert.notDeepEqual(vsAvg.avg, vsAvg.cur, '公司均值不应等于本所单值');
  assert.ok(vsAvg.avg.every((v, i) => Math.abs(v - vsAvg.cur[i]) > 1), '均值与本所值应有可区分差距');
});

test('waste demo detail explains empty intervals outside the two demo windows', async () => {
  const { result } = await runWaste('local_waste_detail', { kind: 'heatmap', start: '2026-03-01', end: '2026-03-31' });
  assert.equal(result.max, 0);
  assert.ok((result.warnings || []).some(w => /仅覆盖 2025-10-01 ~ 2025-10-13 与 2026-10-01 ~ 2026-10-13/.test(w)), '空区间应提示演示窗口');
});

test('waste demo mode refuses arbitrary SQL and returns demo schema outline', async () => {
  await assert.rejects(runWaste('local_biz_query', { sql: 'SELECT 1' }), /演示模式不支持任意 SQL/);
  const schema = (await runWaste('local_biz_schema', {})).result;
  assert.ok(schema.tables.some(t => t.name === 'biz_snapshot'), 'demo schema 应返回演示表清单');
});

test('waste read-only guard blocks writes without false positives', () => {
  // 放行：字符串字面量、注释、列名中的业务字样
  for (const sql of [
    "SELECT * FROM sys_log WHERE action = 'delete'",
    "SELECT '-- insert 注释' AS x",
    'SELECT 1 -- update 注释',
    'SELECT load_flag, update_time FROM t',
  ]) assert.equal(assertReadOnlySql(sql), sql.replace(/;+\s*$/, ''), `应放行：${sql}`);
  // 拦截：写操作、多语句、文件读取与写出
  assert.throws(() => assertReadOnlySql('UPDATE t SET a = 1'), /仅支持只读查询/);
  assert.throws(() => assertReadOnlySql('SELECT 1; DROP TABLE t'), /只允许单条 SQL/);
  assert.throws(() => assertReadOnlySql('SELECT LOAD_FILE("/etc/passwd")'), /LOAD_FILE/);
  assert.throws(() => assertReadOnlySql("SELECT * FROM t INTO OUTFILE '/tmp/x'"), /INTO OUTFILE/);
  assert.throws(() => assertReadOnlySql('SELECT * FROM t FOR UPDATE'), /FOR UPDATE/);
  assert.throws(() => assertReadOnlySql('SELECT * FROM t WHERE id = 1 LOCK IN SHARE MODE'), /LOCK/);
});

// ==================== 经营分析 · Excel 数据分析（excel-agent-kit） ====================
const excelCapabilities = ['local_excel_doctor', 'local_excel_profile', 'local_excel_validate', 'local_excel_report'];
const signal = new AbortController().signal;
test('excel tools are registered in local capabilities', () => {
  for (const code of excelCapabilities) assert.ok(capabilities.includes(code), `缺少 ${code}`);
});

test('excel doctor reports interpreter and dependency status', async () => {
  const { result } = await executeLocal(wasteCall('local_excel_doctor', {}), os.tmpdir(), signal);
  assert.ok(['full', 'partial', 'blocked'].includes(result.status), 'status 应为 full/partial/blocked');
  if (result.status !== 'blocked') {
    assert.ok(result.python, '应报告 Python 版本');
    assert.ok(result.deps, '应报告依赖状态');
    if (result.status === 'partial') assert.ok(result.hint, 'partial 应给出缺项提示');
  }
});

test('excel profile, validate and report run on a generated workbook', async () => {
  const doctor = (await executeLocal(wasteCall('local_excel_doctor', {}), os.tmpdir(), signal)).result;
  if (doctor.status === 'blocked') return; // 无可用 Python 环境：跳过（由 setup-excel-runtime.ps1 安装）
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kla-excel-'));
  const xlsx = path.join(root, 'sales.xlsx');
  try {
    // 用 doctor 解析到的同一解释器造测试工作簿（含已取消单与重复行）
    const gen = [
      'import openpyxl',
      'wb = openpyxl.Workbook(); ws = wb.active; ws.title = "订单明细"',
      'ws.append(["订单号", "订单日期", "大区", "销售额_元", "订单状态"])',
      'for r in [["A1","2026-01-05","华东",1000,"已完成"],["A2","2026-01-06","华东",2000,"已完成"],',
      '          ["A3","2026-02-07","华北",1500,"已完成"],["A4","2026-02-08","华北",500,"已取消"],',
      '          ["A5","2026-02-09","华东","","已完成"],["A1","2026-01-05","华东",1000,"已完成"]]: ws.append(r)',
      'ws2 = wb.create_sheet("月度销售汇总"); ws2.append(["月份","大区","销售额_元"])',
      'ws2.append(["2026-01","华东",3000]); ws2.append(["2026-02","华北",1500])',
      `wb.save(${JSON.stringify(xlsx)})`,
    ].join('\n');
    const gen0 = require('node:child_process').spawnSync(doctor.pythonPath, ['-X', 'utf8', '-c', gen], { encoding: 'utf8' });
    assert.equal(gen0.status, 0, '测试工作簿生成失败：' + (gen0.stderr || '').slice(-300));

    // 画像：两张表、字段形态、重复行识别
    const profileOut = await executeLocal(wasteCall('local_excel_profile', { path: xlsx }), root, signal);
    const profile = profileOut.result;
    assert.ok(profile.summary, '画像应返回摘要');
    assert.equal(profile.summary.sheetCount, 2);
    assert.equal(profile.summary.totalIssues > 0, true, '应识别出质量问题（空值/重复行）');
    assert.ok(profile.uploaded, '画像产物应回传');

    // 溯源校验：排除已取消单独立重算 + 明细汇总勾稽 + 源文件未修改
    // 注意：独立重算按原始行累加不去重（重复行由画像报告给用户决策），1000+2000+1500+1000=5500
    const validate = (await executeLocal(wasteCall('local_excel_validate', {
      path: xlsx, sheet: '订单明细', sum: ['销售额_元'], count: true,
      filterCol: '订单状态', filterExclude: '已取消',
      reconcileDetail: '订单明细', reconcileDKeys: '订单日期,大区', reconcileDValue: '销售额_元',
      reconcileSummary: '月度销售汇总', reconcileSKeys: '月份,大区', reconcileSValue: '销售额_元',
    }), root, signal)).result;
    assert.ok(validate.summary, '校验应返回摘要');
    assert.equal(validate.summary.sourceUnchanged, true, '源文件哈希复验应通过');
    assert.ok(validate.summary.sourceFingerprint.sha256, '应给出 SHA256 指纹');
    assert.equal(validate.summary.independentRecalc.sums['销售额_元'], 5500, '排除已取消单后应为 5500');

    // HTML 报告：full 走成功路径；partial 断言缺依赖的友好提示
    // 输入用画像回传的 profile.json 文本（端到端，不硬编码 workspace 路径）
    const reportInput = (profileOut.artifacts || []).find(x => x.fileName === 'profile.json');
    assert.ok(reportInput && reportInput.content, '画像应回传 profile.json 文本');
    const report = (await executeLocal(wasteCall('local_excel_report', { content: reportInput.content }), root, signal)).result;
    if (doctor.status === 'full') {
      assert.ok(report.fileName && report.fileName.endsWith('.html'), 'full 环境应产出 HTML');
      assert.equal(report.uploaded, true);
    } else {
      assert.match(report.error || '', /matplotlib/, 'partial 环境应提示缺 matplotlib');
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('excel report rejects a missing input file with a helpful message', async () => {
  await assert.rejects(
    executeLocal(wasteCall('local_excel_report', { jsonPath: path.join(os.tmpdir(), 'definitely-not-exists.json') }), os.tmpdir(), signal),
    /报告输入文件不存在.*local_excel_profile|local_excel_validate/,
  );
});
