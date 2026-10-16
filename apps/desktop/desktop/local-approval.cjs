const { randomUUID } = require('node:crypto');

const actions = {
  local_read: '读取本地文件', local_list: '查看本地目录', local_write: '写入本地文件', local_code: '保存代码文件',
  local_bat: '运行 BAT 脚本', local_cli: '运行命令行程序', local_file_fetch: '下载群聊共享文件', local_file_publish: '发布本地文件为群聊成果',
  local_route_matrix: '调用高德计算距离、时间或过路费矩阵', local_route_optimize: '执行路线顺序优化计算',
  local_route_replan: '执行线路拆分与重排计算', local_route_map: '生成优化前后路线对比地图',
  local_waste_status: '查询经营分析数据源与快照状态', local_waste_report: '生成垃圾量经营分析报告',
  local_waste_detail: '查询垃圾量明细分析（热力图/分类同比/班次等）',
  local_biz_configure: '管理经营分析数据源连接（可切换数据库）', local_biz_schema: '探查数据库表结构', local_biz_query: '执行只读 SQL 查询',
  local_excel_doctor: '检查 Excel 分析环境（内置引擎自检）', local_excel_profile: '执行 Excel 数据画像与质量探查（只读源文件）',
  local_excel_validate: '执行 Excel 溯源校验与双路径对账（只读源文件）', local_excel_report: '生成 Excel 分析 HTML 报告',
  local_business_metrics: '只读用户指定的本次原始经营材料并提取证据', local_business_goal_decompose: '依据真实材料拆解公司目标到部门与 KPI',
  local_business_deviation: '对比计划与实际，识别经营偏差、根因和对策', local_business_plan: '生成公司整体或指定部门的经营规划',
  local_business_ppt: '生成可编辑的三一规划 PPTX 成果',
  local_code_scan: '只读扫描项目结构、技术栈、测试现状与依赖清单', local_code_impact: '只读分析 Git 变更影响面与反向依赖',
  local_code_read: '按行号读取项目源码片段（只读，用于收集证据）',
  local_ppt_doctor: '检查本地 PPT 环境', local_ppt_theme_list: '浏览新版 PPT 主题', local_ppt_dsl_validate: '校验 PPT 页面布局', local_ppt_build: '生成 PPTX 并检查与渲染', local_ppt_inspect: '读取 PPTX 内容与备注', local_ppt_render: '检查并渲染本地 PPTX',
};
function describeRequest(call) {
  const action = actions[call.tool];
  if (!action) return null;
  const args = call.arguments || {};
  const details = [];
  const add = (label, value, code = false) => { if (value !== undefined && value !== null && String(value)) details.push({ label, value: String(value), code }); };
  if (call.tool === 'local_cli') {
    add('执行程序', args.executable, true);
    if (Array.isArray(args.args) && args.args.length) add('命令参数', args.args.map(arg => JSON.stringify(String(arg))).join(' '), true);
  } else if (call.tool === 'local_bat') add('执行脚本', args.script, true);
  else if (call.tool === 'local_file_fetch') add(args.fileId ? '附件编号' : '成果编号', args.fileId || args.artifactId, true);
  else if (call.tool.startsWith('local_route')) {
    if (Array.isArray(args.points)) add('点位数量', `${args.points.length} 个点位`);
    add('线路名称', args.routeName);
    add('计算策略', args.strategy);
    add('拆分线路', args.numRoutes);
    add('矩阵类型', args.kind);
  }
  else if (call.tool.startsWith('local_waste')) {
    if (call.tool === 'local_waste_report') { add('统计范围', args.scope === 'company' ? '公司级' : args.scope); add('报表类型', args.periodType === 'year' ? '年报' : args.periodType === 'quarter' ? '季报' : '月报'); add('统计年份', args.year); }
    else if (call.tool === 'local_waste_detail') { add('分析类型', { heatmap: '收运时段热力图', category_yoy: '分类作业量同比', shift: '班次垃圾量', unit_category: '作业所×垃圾类型', unit_vs_avg: '本所与公司均值对比' }[args.kind] || args.kind); add('开始日期', args.start); add('结束日期', args.end); add('区域', args.unit); }
  }
  else if (call.tool.startsWith('local_biz')) {
    if (call.tool === 'local_biz_configure') { add('操作', { set: '设置连接', activate: '切换连接', remove: '删除连接', list: '查看连接' }[args.action] || args.action); if (args.host) add('数据库', `${args.host}:${args.port || 3306}/${args.database || ''}`); add('连接名', args.name); }
    if (call.tool === 'local_biz_schema') add('操作', '读取表结构与抽样数据');
    if (call.tool === 'local_biz_query') { add('SQL', String(args.sql || '').slice(0, 200), true); add('行数上限', args.maxRows); }
  }
  else if (call.tool.startsWith('local_excel')) {
    if (call.tool === 'local_excel_profile') { add('Excel 文件', args.path, true); if (Array.isArray(args.sheets) && args.sheets.length) add('限定工作表', args.sheets.join('、')); add('枚举上限', args.maxEnum); }
    else if (call.tool === 'local_excel_validate') {
      add('Excel 文件', args.path, true); add('重算工作表', args.sheet);
      if (Array.isArray(args.sum) && args.sum.length) add('求和列', args.sum.join('、'));
      if (args.count) add('计数', '是');
      if (args.filterCol) add('排除条件', `${args.filterCol} 不含 ${args.filterExclude || ''}`);
      if (args.reconcileDetail && args.reconcileSummary) add('双向勾稽', `${args.reconcileDetail} ↔ ${args.reconcileSummary}`);
    }
    else if (call.tool === 'local_excel_report') { add('输入', args.jsonPath || '内联 JSON', true); add('主题', args.theme === 'dark' ? '暗色' : '亮色'); add('报告名', args.fileName); }
    else add('检查内容', '内置引擎（exceljs）');
  }
  else if (call.tool.startsWith('local_business')) {
    if (Array.isArray(args.paths)) add('本次源材料', args.paths.join('\n'), true);
    add('材料凭据', args.sourceSetId, true); add('业务主体', args.company); add('分析/规划期间', args.period); add('用户目标', args.objective);
    add('部门', args.department); add('报告名', args.fileName);
    if (call.tool === 'local_business_metrics') add('读取方式', '只读指定文件或目录本层，不扫描其他目录；不使用内置历史数据');
    if (call.tool === 'local_business_ppt') add('构建流程', '真实材料分析 → STORY/DESIGN → 页面校验 → 可编辑 PPTX');
  }
  else if (call.tool.startsWith('local_code_')) {
    add('项目路径', args.root, true);
    if (call.tool === 'local_code_impact') { if (args.range) add('Git 范围', args.range, true); if (args.compareWith) add('对比快照', args.compareWith, true); }
    if (call.tool === 'local_code_read') { add('目标文件', args.file, true); if (args.startLine) add('起始行', args.startLine); }
  }
  else if (call.tool === 'local_ppt_doctor') add('检查内容', 'Python 依赖、中文字体、Office / WPS 渲染器及新版 slidep');
  else if (call.tool === 'local_ppt_theme_list') add('筛选主题', args.query || '全部');
  else if (call.tool === 'local_ppt_dsl_validate') add('页面文件', args.fileName || 'page.slide', true);
  else if (call.tool === 'local_ppt_build') {
    add('文稿名称', args.fileName || '演示文稿.pptx', true);
    add('提交页面', Array.isArray(args.slides) ? args.slides.map(slide => slide.pageNumber).join('、') || '沿用已有页面' : '未提供');
    add('构建方式', args.finalize === false ? '中间草稿，不上传成果' : '最终交付');
    if (args.documentId) add('续稿文档', args.documentId, true);
  }
  else add(args.path ? '文件路径' : args.documentId ? '文档编号' : '文件名称', args.path || args.documentId || args.fileName, true);
  add('工作目录', args.cwd, true);
  if (args.timeoutMs) add('执行时限', `${args.timeoutMs / 1000} 秒`);
  if (call.tool === 'local_write' || call.tool === 'local_code') add('写入内容', `${String(args.content || '').length.toLocaleString('zh-CN')} 个字符`);
  return { action, details, tool: call.tool, runId: String(call.runId), execution: '本机 · 当前系统用户权限' };
}

/** Approval stays bound to one request, one trusted window and the active execution signal. */
function createLocalApprovalBridge(ipcMain, trusted) {
  const pending = new Map();
  ipcMain.handle('kla:approval-pending', event => {
    if (!trusted(event)) throw new Error('UNTRUSTED_FRAME');
    return pending.get(event.sender.id)?.request || null;
  });
  ipcMain.handle('kla:approval-decide', (event, decision) => {
    if (!trusted(event)) throw new Error('UNTRUSTED_FRAME');
    const item = pending.get(event.sender.id);
    if (!item || item.request.id !== decision?.id || typeof decision?.approved !== 'boolean') return { accepted: false };
    item.finish(decision.approved);
    return { accepted: true };
  });
  return {
    request(window, call, signal) {
      const description = describeRequest(call);
      if (!description || !window || window.isDestroyed() || signal?.aborted) return Promise.resolve(false);
      const contents = window.webContents;
      if (contents.isDestroyed() || contents.isLoadingMainFrame()) return Promise.resolve(false);
      pending.get(contents.id)?.finish(false);
      const request = { id: randomUUID(), ...description };
      return new Promise(resolve => {
        let settled = false;
        const finish = approved => {
          if (settled) return;
          settled = true;
          const allowed = approved === true && !signal?.aborted && !window.isDestroyed() && !contents.isDestroyed();
          pending.delete(contents.id);
          signal?.removeEventListener('abort', cancel);
          window.removeListener('closed', cancel);
          contents.removeListener('destroyed', cancel);
          contents.removeListener('render-process-gone', cancel);
          contents.removeListener('did-start-navigation', navigation);
          try { if (!contents.isDestroyed()) contents.send('kla:approval-changed', null); } catch { /* A closed renderer cannot acknowledge dismissal. */ }
          resolve(allowed);
        };
        const cancel = () => finish(false);
        const navigation = details => { if (details.isMainFrame && !details.isSameDocument) cancel(); };
        pending.set(contents.id, { request, finish });
        signal?.addEventListener('abort', cancel, { once: true });
        window.once('closed', cancel);
        contents.once('destroyed', cancel);
        contents.once('render-process-gone', cancel);
        contents.on('did-start-navigation', navigation);
        if (signal?.aborted) { cancel(); return; }
        try {
          contents.send('kla:approval-changed', request);
          if (window.isMinimized()) window.restore();
          window.show(); window.focus();
        } catch { cancel(); }
      });
    },
  };
}
module.exports = { createLocalApprovalBridge };
