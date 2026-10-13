const { randomUUID } = require('node:crypto');

const actions = {
  local_read: '读取本地文件', local_list: '查看本地目录', local_write: '写入本地文件', local_code: '保存代码文件',
  local_bat: '运行 BAT 脚本', local_cli: '运行命令行程序', local_file_fetch: '下载群聊共享文件', local_file_publish: '发布本地文件为群聊成果',
  local_ppt_doctor: '检查本地 PPT 环境', local_ppt_build: '生成 PPTX 并检查与渲染', local_ppt_inspect: '读取 PPTX 内容与备注', local_ppt_render: '检查并渲染本地 PPTX',
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
  else if (call.tool === 'local_ppt_doctor') add('检查内容', 'Python 依赖、中文字体及 Office / WPS 渲染器');
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
