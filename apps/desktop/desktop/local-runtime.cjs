const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID,createHash}=require('node:crypto');
const {executeLocal,capabilities}=require('./local-tools.cjs');
const {workspacePaths,updateWorkspaceState,cleanupWorkspace}=require('./local-workspace.cjs');
class LocalRuntime {
  constructor(userData,apiBaseUrl,approve=async()=>false){this.root=path.resolve(process.env.KLA_LOCAL_WORKSPACE_ROOT||path.join(userData,'agent-runtime'));this.base=apiBaseUrl.replace(/\/$/,'');this.approve=approve;this.session=null;this.deviceId=null;this.timer=null;this.polling=false;this.active=null;this.error=null;this.generation=0;this.transition=Promise.resolve();this.workspaceTtlHours=Math.max(1,Number(process.env.KLA_LOCAL_WORKSPACE_TTL_HOURS||24));this.workspaceMaxBytes=Math.max(1,Number(process.env.KLA_LOCAL_WORKSPACE_MAX_BYTES||2*1024*1024*1024));}
  async save(file,value){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(value),'utf8');await fs.rename(tmp,file);}
  async api(url,body,method='POST',session=this.session){
    if(!session)throw new Error('桌面尚未登录');
    const response=await fetch(this.base+url,{method,headers:{authorization:'Bearer '+session.accessToken,'x-identity-id':session.identityId,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
    const data=await response.json();if(!response.ok||!data.ok){const e=new Error(data.error?.message??'执行设备连接失败');e.status=response.status;throw e;}return data.data;
  }
  async downloadInput(call,signal,session=this.session,deviceId=this.deviceId){
    if(!session||!deviceId)throw new Error('执行设备未连接');
    const response=await fetch(`${this.base}/v1/runtime/devices/${deviceId}/calls/${call.id}/input`,{headers:{authorization:'Bearer '+session.accessToken,'x-identity-id':session.identityId},signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});
    if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error?.message||'共享文件下载失败');}
    const limit=100*1024*1024;
    if(Number(response.headers.get('content-length'))>limit)throw new Error('共享文件超过本地下载限制');
    const parts=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>limit){await response.body.cancel().catch(()=>{});throw new Error('共享文件超过本地下载限制');}parts.push(Buffer.from(chunk));}
    const bytes=Buffer.concat(parts),checksum=response.headers.get('x-kla-checksum');
    if(checksum&&createHash('sha256').update(bytes).digest('hex')!==checksum)throw new Error('共享文件完整性校验失败');
    return{name:decodeURIComponent(response.headers.get('x-kla-file-name')||''),bytes};
  }
  connect(session){const next=this.transition.then(()=>this.doConnect(session));this.transition=next.catch(()=>{});return next;}
  async doConnect(session){
    if(!session?.accessToken||!/^[a-f\d-]{36}$/i.test(session.identityId))throw new Error('登录信息无效');
    if(this.session?.identityId!==session.identityId)await this.doDisconnect();this.session=session;
    await fs.mkdir(this.root,{recursive:true});const installationFile=path.join(this.root,'installation.json');
    let installation;try{installation=JSON.parse(await fs.readFile(installationFile,'utf8'));}catch{installation={id:randomUUID()};await this.save(installationFile,installation);}
    await this.cleanupIdentityWorkspace(session.identityId);
    const registered=await this.api('/v1/runtime/devices',{installationId:installation.id,name:os.hostname(),platform:process.platform,capabilities});this.deviceId=registered.id;this.error=null;
    if(!this.timer){this.timer=setInterval(()=>void this.poll(),2000);this.timer.unref();}void this.poll();return this.status();
  }
  status(){return{connected:Boolean(this.session&&this.deviceId),deviceId:this.deviceId,activeCallId:this.active?.id??null,error:this.error};}
  disconnect(){const next=this.transition.then(()=>this.doDisconnect());this.transition=next.catch(()=>{});return next;}
  async doDisconnect(){this.generation++;if(this.timer)clearInterval(this.timer);this.timer=null;this.active?.controller.abort();if(this.session&&this.deviceId){try{await this.api(`/v1/runtime/devices/${this.deviceId}/connection`,null,'DELETE');}catch{/* Offline disconnect is handled by heartbeat expiry. */}}this.session=null;this.deviceId=null;}
  async cleanupIdentityWorkspace(identityId){
    if(!this.deviceId||this.session?.identityId!==identityId)return;
    const session={...this.session},deviceId=this.deviceId,generation=this.generation;
    this.lastCleanup??=new Map();
    if(Date.now()-(this.lastCleanup.get(identityId)||0)<60000)return;
    this.lastCleanup.set(identityId,Date.now());
    const identityRoot=path.join(this.root,identityId);
    await fs.mkdir(path.join(identityRoot,'journals'),{recursive:true});
    try{
      const names=await fs.readdir(path.join(identityRoot,'runs')).catch(error=>{if(error.code==='ENOENT')return[];throw error;});
      const runIds=names.filter(name=>/^[a-f\d-]{36}$/i.test(name));
      const terminalRunIds=[];
      for(let offset=0;offset<runIds.length;offset+=200){
        const runs=await this.api(`/v1/runtime/devices/${deviceId}/workspaces/status`,{runIds:runIds.slice(offset,offset+200)},'POST',session);
        if(this.generation!==generation||this.deviceId!==deviceId)return;
        terminalRunIds.push(...runs.filter(run=>['completed','failed','cancelled'].includes(run.status)).map(run=>run.runId));
      }
      await cleanupWorkspace(identityRoot,{ttlHours:this.workspaceTtlHours,maxBytes:this.workspaceMaxBytes,terminalRunIds});
    }catch(e){this.error=`本地任务目录清理失败：${e.message}`;}
  }
  async acknowledgeJournal(journalFile,journal,session=this.session,deviceId=this.deviceId){
    const identityId=session.identityId;
    await this.api(`/v1/runtime/devices/${deviceId}/calls/${journal.call.id}/receipt`,journal.receipt,'POST',session);
    journal.state='acknowledged';
    journal.acknowledgedAt=new Date().toISOString();
    await this.save(journalFile,journal);
    await updateWorkspaceState(workspacePaths(path.join(this.root,identityId),journal.call),'acknowledged');
  }
  async poll(){
    if(this.polling||!this.session||!this.deviceId)return;this.polling=true;
    const session={...this.session},deviceId=this.deviceId,generation=this.generation;
    const current=()=>this.generation===generation&&this.deviceId===deviceId&&this.session?.identityId===session.identityId;
    try{
      const identityRoot=path.join(this.root,session.identityId);const journalRoot=path.join(identityRoot,'journals');await fs.mkdir(journalRoot,{recursive:true});
      await this.cleanupIdentityWorkspace(session.identityId);if(!current())return;
      for(const file of await fs.readdir(journalRoot))if(file.endsWith('.json')){
        if(!current())return;
        const journalFile=path.join(journalRoot,file);const journal=JSON.parse(await fs.readFile(journalFile,'utf8'));
        if(journal.state==='running'&&this.active?.id!==journal.call.id){journal.state='receipt';journal.receipt={receiptId:randomUUID(),status:'failed',result:{error:'设备执行被中断，副作用结果未知；未重复执行'},approval:{approved:false,decidedAt:new Date().toISOString()}};await this.save(journalFile,journal);}
        if(journal.state==='receipt'){
          if(!journal.receipt.approval){journal.receipt={receiptId:journal.receipt.receiptId,status:'failed',result:{error:'旧版回执缺少审批记录，执行结果不确定；未重复执行'},approval:{approved:false,decidedAt:new Date().toISOString()}};await this.save(journalFile,journal);}
          try{await this.acknowledgeJournal(journalFile,journal,session,deviceId);}catch(e){if(e.status===409||e.status===404){journal.state='discarded';journal.discardedAt=new Date().toISOString();await this.save(journalFile,journal);await updateWorkspaceState(workspacePaths(identityRoot,journal.call),'discarded');}else throw e;}
        }
      }
      if(!current())return;
      const response=await this.api(`/v1/runtime/devices/${deviceId}/poll`,undefined,'POST',session);if(!current())return;
      if(this.active&&response.cancelled.includes(this.active.id))this.active.controller.abort();
      if(response.call&&!this.active){const call=response.call;const file=path.join(journalRoot,call.id+'.json');let previous;try{previous=JSON.parse(await fs.readFile(file,'utf8'));}catch{/* New call. */}
        if(!previous){await this.save(file,{state:'running',call});const controller=new AbortController();if(!current())controller.abort();this.active={id:call.id,controller};
          const executionSession=session,executionDevice=deviceId;void (async()=>{let receipt;let approval={approved:false,decidedAt:new Date().toISOString()};try{controller.signal.throwIfAborted();const approved=await this.approve(call);approval={approved,decidedAt:new Date().toISOString()};if(!approved)throw new Error('用户拒绝本地操作');controller.signal.throwIfAborted();const outcome=await executeLocal(call,identityRoot,controller.signal,approved && ['local_read','local_list','local_file_publish','local_ppt_inspect','local_ppt_render'].includes(call.tool),(inputCall,signal)=>this.downloadInput(inputCall,signal,executionSession,executionDevice));receipt={receiptId:randomUUID(),status:outcome.result.error?'failed':'completed',...outcome,approval};}catch(e){receipt={receiptId:randomUUID(),status:'failed',result:{error:e.message},approval};}
            await this.save(file,{state:'receipt',call,receipt});try{await updateWorkspaceState(workspacePaths(identityRoot,call),'receipt');}catch{/* Unacknowledged output must be preserved for replay. */}if(this.active?.id===call.id)this.active=null;if(this.generation===generation)void this.poll();
          })().catch(e=>{this.error=e.message;this.active=null;});
        }
      }
      this.error=null;
    }catch(e){if(current()){this.error=e.message;if(e.status===401||e.status===403){this.active?.controller.abort();if(this.timer)clearInterval(this.timer);this.timer=null;}}}
    finally{this.polling=false;}
  }
}
module.exports={LocalRuntime};
