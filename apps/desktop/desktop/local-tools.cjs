const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

const capabilities = ['local_read','local_list','local_write','local_code','local_bat','local_cli'];
function absolute(value) { if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('本地路径必须是绝对路径'); return path.resolve(value); }
function filename(value) { if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(value)) throw new Error('文件名无效'); return value; }
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
async function executeLocal(call,root,signal) {
  if(!capabilities.includes(call.tool))throw new Error('不支持的本地技能');signal.throwIfAborted();
  const a=call.arguments;const folder=path.join(root,call.runId,call.stepId);await fs.mkdir(folder,{recursive:true});
  if(call.tool==='local_read'){const target=absolute(a.path);const stat=await fs.stat(target);if(stat.size>10_000_000)throw new Error('文本读取限 10 MB，请用 CLI 分段处理');const text=await fs.readFile(target,'utf8');return{result:{content:text.slice(a.offset??0,(a.offset??0)+(a.maxChars??20000)),sizeBytes:stat.size,truncated:text.length>(a.offset??0)+(a.maxChars??20000)}};}
  if(call.tool==='local_list'){const entries=await fs.readdir(absolute(a.path),{withFileTypes:true});return{result:{entries:entries.slice(0,2000).map(e=>({name:e.name,directory:e.isDirectory()})),truncated:entries.length>2000}};}
  if(call.tool==='local_write'||call.tool==='local_code'){
    const name=filename(a.fileName);if(typeof a.content!=='string'||a.content.length>1_000_000)throw new Error('文件内容过大或无效');const target=a.path?absolute(a.path):path.join(folder,name);
    signal.throwIfAborted();await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,a.content,'utf8');
    const content=await fs.readFile(target,'utf8');const checksum=createHash('sha256').update(content).digest('hex');
    const mimeType=path.extname(name).toLowerCase()==='.html'?'text/html':'text/plain';
    // Local absolute paths stay in the device journal; only the stable file name goes back to the server.
    return{result:{fileName:name,sizeBytes:Buffer.byteLength(content),stored:true},artifact:{fileName:name,content,mimeType,checksum}};
  }
  const cwd=a.cwd?absolute(a.cwd):folder;const timeout=Math.max(1000,Math.min(Number(a.timeoutMs)||60000,300000));
  if(call.tool==='local_bat'){
    if(process.platform!=='win32')throw new Error('BAT 仅支持 Windows 设备');
    const script=path.join(folder,`command-${filename(call.id)}.bat`);await fs.writeFile(script,'@echo off\r\nchcp 65001 >nul\r\n'+a.script,'utf8');
    return{result:await command('cmd.exe',['/d','/s','/c',`"${script}"`],cwd,timeout,signal)};
  }
  if(typeof a.executable!=='string'||!a.executable||!Array.isArray(a.args)||a.args.some(x=>typeof x!=='string'))throw new Error('CLI 参数无效');
  return{result:await command(a.executable,a.args,cwd,timeout,signal)};
}
module.exports={executeLocal,capabilities};
