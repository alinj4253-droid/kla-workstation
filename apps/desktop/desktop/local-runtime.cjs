const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const {executeLocal,capabilities}=require('./local-tools.cjs');
class LocalRuntime {
  constructor(userData,apiBaseUrl,approve=async()=>false){this.root=path.join(userData,'agent-runtime');this.base=apiBaseUrl.replace(/\/$/,'');this.approve=approve;this.session=null;this.deviceId=null;this.timer=null;this.polling=false;this.active=null;this.error=null;this.generation=0;this.transition=Promise.resolve();}
  async save(file,value){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(value),'utf8');await fs.rename(tmp,file);}
  async api(url,body,method='POST'){
    const session=this.session;if(!session)throw new Error('桌面尚未登录');
    const response=await fetch(this.base+url,{method,headers:{authorization:'Bearer '+session.accessToken,'x-identity-id':session.identityId,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
    const data=await response.json();if(!response.ok||!data.ok){const e=new Error(data.error?.message??'执行设备连接失败');e.status=response.status;throw e;}return data.data;
  }
  connect(session){const next=this.transition.then(()=>this.doConnect(session));this.transition=next.catch(()=>{});return next;}
  async doConnect(session){
    if(!session?.accessToken||!/^[a-f\d-]{36}$/i.test(session.identityId))throw new Error('登录信息无效');
    if(this.session?.identityId!==session.identityId)await this.doDisconnect();this.session=session;
    await fs.mkdir(this.root,{recursive:true});const installationFile=path.join(this.root,'installation.json');
    let installation;try{installation=JSON.parse(await fs.readFile(installationFile,'utf8'));}catch{installation={id:randomUUID()};await this.save(installationFile,installation);}
    const registered=await this.api('/v1/runtime/devices',{installationId:installation.id,name:os.hostname(),platform:process.platform,capabilities});this.deviceId=registered.id;this.error=null;
    if(!this.timer){this.timer=setInterval(()=>void this.poll(),2000);this.timer.unref();}void this.poll();return this.status();
  }
  status(){return{connected:Boolean(this.session&&this.deviceId),deviceId:this.deviceId,activeCallId:this.active?.id??null,error:this.error};}
  disconnect(){const next=this.transition.then(()=>this.doDisconnect());this.transition=next.catch(()=>{});return next;}
  async doDisconnect(){this.generation++;if(this.timer)clearInterval(this.timer);this.timer=null;this.active?.controller.abort();if(this.session&&this.deviceId){try{await this.api(`/v1/runtime/devices/${this.deviceId}/connection`,null,'DELETE');}catch{/* Offline disconnect is handled by heartbeat expiry. */}}this.session=null;this.deviceId=null;}
  async poll(){
    if(this.polling||!this.session||!this.deviceId)return;this.polling=true;
    try{
      const folder=path.join(this.root,this.session.identityId);await fs.mkdir(folder,{recursive:true});
      for(const file of await fs.readdir(folder))if(file.endsWith('.json')){
        const journal=JSON.parse(await fs.readFile(path.join(folder,file),'utf8'));
        if(journal.state==='running'&&this.active?.id!==journal.call.id){journal.state='receipt';journal.receipt={receiptId:randomUUID(),status:'failed',result:{error:'设备执行被中断，副作用结果未知；未重复执行'},approval:{approved:false,decidedAt:new Date().toISOString()}};await this.save(path.join(folder,file),journal);}
        if(journal.state==='receipt'){
          if(!journal.receipt.approval){journal.receipt={receiptId:journal.receipt.receiptId,status:'failed',result:{error:'旧版回执缺少审批记录，执行结果不确定；未重复执行'},approval:{approved:false,decidedAt:new Date().toISOString()}};await this.save(path.join(folder,file),journal);}
          try{await this.api(`/v1/runtime/devices/${this.deviceId}/calls/${journal.call.id}/receipt`,journal.receipt);journal.state='acknowledged';await this.save(path.join(folder,file),journal);}catch(e){if(e.status===409||e.status===404){journal.state='discarded';await this.save(path.join(folder,file),journal);}else throw e;}
        }
      }
      const response=await this.api(`/v1/runtime/devices/${this.deviceId}/poll`);
      if(this.active&&response.cancelled.includes(this.active.id))this.active.controller.abort();
      if(response.call&&!this.active){const call=response.call;const file=path.join(folder,call.id+'.json');let previous;try{previous=JSON.parse(await fs.readFile(file,'utf8'));}catch{/* New call. */}
        if(!previous){await this.save(file,{state:'running',call});const controller=new AbortController();const generation=this.generation;this.active={id:call.id,controller};
          void (async()=>{let receipt;let approval={approved:false,decidedAt:new Date().toISOString()};try{const approved=await this.approve(call);approval={approved,decidedAt:new Date().toISOString()};if(!approved)throw new Error('用户拒绝本地操作');controller.signal.throwIfAborted();const outcome=await executeLocal(call,path.join(folder,'tasks'),controller.signal);receipt={receiptId:randomUUID(),status:outcome.result.error?'failed':'completed',...outcome,approval};}catch(e){receipt={receiptId:randomUUID(),status:'failed',result:{error:e.message},approval};}
            await this.save(file,{state:'receipt',call,receipt});if(this.active?.id===call.id)this.active=null;if(this.generation===generation)void this.poll();
          })().catch(e=>{this.error=e.message;this.active=null;});
        }
      }
      this.error=null;
    }catch(e){this.error=e.message;if(e.status===401||e.status===403){this.active?.controller.abort();if(this.timer)clearInterval(this.timer);this.timer=null;}}
    finally{this.polling=false;}
  }
}
module.exports={LocalRuntime};
