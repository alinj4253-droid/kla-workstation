const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { ensureWorkspace } = require('./local-workspace.cjs');

const ppt = require('./local-ppt.cjs');
const route = require('./local-route.cjs');
const businessPlanner = require('./local-business-planner.cjs');
const waste = require('./local-waste.cjs');
const excel = require('./local-excel.cjs');
const codeAnalysis = require('./local-code-analysis.cjs');
const capabilities = ['local_read','local_list','local_write','local_code','local_bat','local_cli','local_file_fetch','local_file_publish', ...ppt.capabilities, ...route.capabilities, ...businessPlanner.capabilities, ...waste.capabilities, ...excel.capabilities, ...codeAnalysis.capabilities];
function localPath(value, root) {
  if (typeof value === 'string' && value.startsWith('workspace://')) {
    const target = path.resolve(root, value.slice('workspace://'.length));
    if (!within(target, root)) throw new Error('工作区引用越界');
    return target;
  }
  return absolute(value);
}
function absolute(value) { if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('本地路径必须是绝对路径'); return path.resolve(value); }
function filename(value) { if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(value)) throw new Error('文件名无效'); return value; }
// 交付物名校验：拦探针/临时/占位文件（模型曾自写 _probe_*.txt 的 ping 内容并被当附件发布）。
// 垃圾词要求前后均为非字母边界（避免误伤 template.html / tmpfile 等正常名）；不拦「测试」「demo」等业务字样。
const JUNK_NAME = /^[_.~]|(^|[^a-z])(probe|ping|scratch|placeholder|tmp|temp|占位|临时)([^a-z]|$)/i;
function assertDeliverableName(name) {
  if (JUNK_NAME.test(name)) throw new Error(`禁止写入探针/临时/占位文件（${name}）。文件保存仅用于最终交付物；能在回复中直接给出的结论不要写文件，需要验证工具时直接调用目标工具。`);
  return name;
}
function within(target, root) { const relative = path.relative(root, target); return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)); }
async function existingParent(target) {
  let candidate = target;
  for (;;) {
    try { return await fs.realpath(candidate); }
    catch (error) { if (error.code !== 'ENOENT') throw error; const parent = path.dirname(candidate); if (parent === candidate) throw error; candidate = parent; }
  }
}
async function allowedPath(target, taskRoot, writing = false) {
  const roots = [taskRoot, ...(process.env.KLA_LOCAL_ALLOWED_ROOTS || '').split(path.delimiter).filter(Boolean)];
  const resolvedRoots = await Promise.all(roots.map(root => fs.realpath(path.resolve(root))));
  let real;
  if (writing) {
    try { real = await fs.realpath(target); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('不允许写入符号链接', { cause: error }); }
      catch (linkError) { if (linkError.code !== 'ENOENT') throw linkError; }
      real = await existingParent(path.dirname(target));
    }
  } else real = await fs.realpath(target);
  if (!resolvedRoots.some(root => within(real, root))) throw new Error('路径不在本地允许目录内');
  return target;
}
async function approvedReadPath(target, taskRoot, approved) {
  try { return await allowedPath(target, taskRoot); }
  catch (error) {
    if (!approved || error.message !== '路径不在本地允许目录内') throw error;
    if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('审批路径不能是符号链接，请使用实际路径重新请求', { cause: error });
    return target;
  }
}
function kill(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') { const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}); killer.on('error',()=>child.kill()); }
  else { try { process.kill(-child.pid,'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}
function command(executable,args,cwd,timeoutMs,signal) {
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',reason='';
    child.stdout.on('data',b=>{stdout=(stdout+b.toString()).slice(-100000);});child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-100000);});
    const abort=()=>{reason='执行已取消';kill(child);};const timer=setTimeout(()=>{reason='执行超时';kill(child);},timeoutMs);
    signal.addEventListener('abort',abort,{once:true});
    const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
    child.on('error',e=>{cleanup();reject(e);});
    child.on('close',exitCode=>{cleanup();if(reason)reject(new Error(reason));else resolve({exitCode,stdout,stderr,...(exitCode!==0?{error:`程序退出码 ${exitCode}`}:{})});});
  });
}
async function executeLocal(call,root,signal,approvedRead=false,downloadInput) {
  if(!capabilities.includes(call.tool))throw new Error('不支持的本地技能');signal.throwIfAborted();
  if(ppt.capabilities.includes(call.tool))return ppt.executePpt(call,root,signal,approvedRead,{command,absolute:value=>localPath(value,root),filename,within,approvedReadPath});
  if(route.capabilities.includes(call.tool))return route.executeRoute(call,root,signal);
  if(businessPlanner.capabilities.includes(call.tool))return businessPlanner.executeBusinessPlanner(call,root,signal,{command,within});
  if(waste.capabilities.includes(call.tool))return waste.executeWaste(call,root,signal);
  if(excel.capabilities.includes(call.tool))return excel.executeExcel(call,root,signal,approvedRead,{command,absolute:value=>localPath(value,root),filename,within,approvedReadPath});
  if(codeAnalysis.capabilities.includes(call.tool))return codeAnalysis.executeCodeAnalysis(call,root,signal,{command});
  const a=call.arguments;
  const workspace=await ensureWorkspace(root,call);
  if(call.tool==='local_file_fetch') {
    if (!downloadInput) throw new Error('共享文件下载连接未配置');
    const input = await downloadInput(call, signal);
    const name = filename(input.name); const target = path.join(workspace.input, name);
    signal.throwIfAborted(); await fs.writeFile(target,input.bytes,{flag:'wx'});
    const reference = 'workspace://' + path.relative(root,target).split(path.sep).join('/');
    return {result:{path:reference,fileName:name,sizeBytes:input.bytes.length,checksum:createHash('sha256').update(input.bytes).digest('hex'),deviceLocal:true}};
  }
  if(call.tool==='local_file_publish') {
    const target=await approvedReadPath(localPath(a.path,root),root,approvedRead);
    const stat=await fs.stat(target);if(!stat.isFile()||stat.size>16*1024*1024)throw new Error('成果发布仅支持不超过 16 MiB 的文件');
    const bytes=await fs.readFile(target);signal.throwIfAborted();
    if(bytes.length>16*1024*1024)throw new Error('成果超过 16 MiB 上传限制');
    const name=filename(a.fileName||path.basename(target)),checksum=createHash('sha256').update(bytes).digest('hex');
    const ext=path.extname(name).toLowerCase();
    const types={'.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.md':'text/markdown','.txt':'text/plain','.csv':'text/csv','.json':'application/json','.html':'text/html'};
    let mimeType=types[ext]||(/\.(js|ts|py|css|log|xml|sh|bat)$/.test(ext)?'text/plain':'application/octet-stream');
    const text=/^text\//.test(mimeType)||mimeType==='application/json';
    const utf8=bytes.toString('utf8'),validText=text&&Buffer.from(utf8).equals(bytes);
    if(text&&!validText)mimeType='application/octet-stream';
    const artifact=process.env.KLA_LOCAL_ARTIFACT_UPLOAD==='false'?undefined:{fileName:name,mimeType,checksum,contentEncoding:validText?'utf8':'base64',content:validText?utf8:bytes.toString('base64')};
    return{result:{fileName:name,sizeBytes:bytes.length,checksum,uploaded:Boolean(artifact),localOnly:!artifact},...(artifact?{artifact}:{})};
  }
  if(call.tool==='local_read'){const target=await approvedReadPath(localPath(a.path,root),root,approvedRead);const stat=await fs.stat(target);if(stat.size>10_000_000)throw new Error('文本读取限 10 MB，请用 CLI 分段处理');const text=await fs.readFile(target,'utf8');return{result:{content:text.slice(a.offset??0,(a.offset??0)+(a.maxChars??20000)),sizeBytes:stat.size,truncated:text.length>(a.offset??0)+(a.maxChars??20000)}};}
  if(call.tool==='local_list'){const target=await approvedReadPath(localPath(a.path,root),root,approvedRead);const entries=await fs.readdir(target,{withFileTypes:true});return{result:{entries:entries.slice(0,2000).map(e=>({name:e.name,directory:e.isDirectory()})),truncated:entries.length>2000}};}
  if(call.tool==='local_write'||call.tool==='local_code'){
    const name=assertDeliverableName(filename(a.fileName));if(typeof a.content!=='string'||a.content.length>1_000_000)throw new Error('文件内容过大或无效');const target=await allowedPath(a.path?localPath(a.path,root):path.join(workspace.output,name),root,true);
    signal.throwIfAborted();await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,a.content,'utf8');
    const content=await fs.readFile(target,'utf8');const checksum=createHash('sha256').update(content).digest('hex');
    const mimeType=path.extname(name).toLowerCase()==='.html'?'text/html':'text/plain';
    // Local absolute paths stay in the device journal; only the stable file name goes back to the server.
    const artifact = process.env.KLA_LOCAL_ARTIFACT_UPLOAD === 'false' ? undefined : {fileName:name,content,mimeType,checksum};
    const reference=within(target,root)?'workspace://'+path.relative(root,target).split(path.sep).join('/'):undefined;
    return{result:{fileName:name,sizeBytes:Buffer.byteLength(content),checksum,stored:true,uploaded:Boolean(artifact),...(reference?{path:reference,deviceLocal:true}:{})},...(artifact?{artifact}:{})};
  }
  const cwd=await allowedPath(a.cwd?localPath(a.cwd,root):workspace.work,root);const timeout=Math.max(1000,Math.min(Number(a.timeoutMs)||60000,300000));
  if(call.tool==='local_bat'){
    if(process.platform!=='win32')throw new Error('BAT 仅支持 Windows 设备');
    const script=path.join(workspace.work,`command-${filename(call.id)}.bat`);await fs.writeFile(script,'@echo off\r\nchcp 65001 >nul\r\n'+a.script,'utf8');
    const outcome=await command('cmd.exe',['/d','/c',script],cwd,timeout,signal);
    await fs.writeFile(path.join(workspace.logs,'command.stdout.log'),outcome.stdout||'','utf8');
    await fs.writeFile(path.join(workspace.logs,'command.stderr.log'),outcome.stderr||'','utf8');
    const reference=within(cwd,root)?'workspace://'+path.relative(root,cwd).split(path.sep).join('/'):undefined;
    return{result:{...outcome,...(reference?{workingDirectory:reference,deviceLocal:true}:{})}};
  }
  if(typeof a.executable!=='string'||!a.executable||!Array.isArray(a.args)||a.args.some(x=>typeof x!=='string'))throw new Error('CLI 参数无效');
  const outcome=await command(a.executable,a.args,cwd,timeout,signal);
  await fs.writeFile(path.join(workspace.logs,'command.stdout.log'),outcome.stdout||'','utf8');
  await fs.writeFile(path.join(workspace.logs,'command.stderr.log'),outcome.stderr||'','utf8');
  const reference=within(cwd,root)?'workspace://'+path.relative(root,cwd).split(path.sep).join('/'):undefined;
  return{result:{...outcome,...(reference?{workingDirectory:reference,deviceLocal:true}:{})}};
}
module.exports={executeLocal,capabilities};
