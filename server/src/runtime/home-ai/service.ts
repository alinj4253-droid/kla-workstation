import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { homeAiConfirmationSchema, type HomeAiToolCode } from '@kla-workstation/contracts';
import { requirePermission } from '../../auth/permission-service.js';
import { assessment, QUESTIONS, record, invalidate, invalidateScene, valueEstimate } from './interview.js';
import { canConfirm, newDiagnostic, sceneFor, sceneReport, sessionView, type DiagnosticState } from './domain.js';
import { accessibleFile } from '../../storage/file-access.js';
import type { ObjectStore } from '../../storage/object-store.js';
import { parseMaterial } from './materials.js';

export type DiagnosticScope = {identityId:string;conversationId:string;toolCallId?:string};
export class HomeAiError extends Error {
  constructor(public readonly code: 'NOT_FOUND'|'FORBIDDEN'|'CONFLICT'|'INVALID_ARGUMENT', message:string) {super(message);}
}
export const homeAiWriteTools = new Set(['home_ai_session_open','home_ai_interview_update','home_ai_conditions_update','home_ai_value_estimate','home_ai_materials_add']);
export class HomeAiService {
  constructor(private readonly pool:Pool, private readonly objectStore?:ObjectStore) {}
  private async authorize(client:Pool|PoolClient,scope:DiagnosticScope) {
    const result=await client.query(`SELECT 1 FROM conversations c JOIN projects p ON p.id=c.project_id
      JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.identity_id=$2
      JOIN project_members pm ON pm.project_id=p.id AND pm.identity_id=cm.identity_id
      JOIN identities i ON i.id=cm.identity_id AND i.status='active'
      WHERE c.id=$1 AND p.owner_identity_id=$2`,[scope.conversationId,scope.identityId]);
    if(!result.rows[0]) throw new HomeAiError('FORBIDDEN','仅项目拥有身份可管理诊断；请切换到该身份并确认仍是项目及群聊成员。');
  }
  private async load(client:Pool|PoolClient,scope:DiagnosticScope,sessionId:string,lock=false) {
    const row=(await client.query(`SELECT * FROM home_ai_sessions WHERE id=$1 AND identity_id=$2 AND conversation_id=$3${lock?' FOR UPDATE':''}`,
      [sessionId,scope.identityId,scope.conversationId])).rows[0];
    if(!row) throw new HomeAiError('NOT_FOUND','此诊断不属于当前身份和群聊；请在当前群聊调用 home_ai_session_open 获取正确编号。');
    return row as {id:string;revision:number;state:DiagnosticState};
  }
  async list(scope:DiagnosticScope) {
    await requirePermission(this.pool,scope.identityId,'read');await this.authorize(this.pool,scope);
    const rows=(await this.pool.query('SELECT id,revision,state FROM home_ai_sessions WHERE identity_id=$1 AND conversation_id=$2 ORDER BY created_at DESC LIMIT 20',
      [scope.identityId,scope.conversationId])).rows;
    return rows.map(row=>sessionView(row.id,row.revision,row.state));
  }
  async execute(name:HomeAiToolCode,args:Record<string,any>,scope:DiagnosticScope):Promise<any> {
    await requirePermission(this.pool,scope.identityId,homeAiWriteTools.has(name)?'write':'read');
    return this.transaction(scope,`tool:${scope.toolCallId??''}`,{name,args},async client=>{
      if(name==='home_ai_session_open') {
        const row=args.sessionId?await this.load(client,scope,args.sessionId):
          (await client.query('INSERT INTO home_ai_sessions(identity_id,conversation_id,state) VALUES($1,$2,$3) RETURNING id,revision,state',
            [scope.identityId,scope.conversationId,JSON.stringify(newDiagnostic())])).rows[0];
        return sessionView(row.id,row.revision,row.state);
      }
      const write=homeAiWriteTools.has(name),row=await this.load(client,scope,args.sessionId,write);
      if(write&&row.revision!==args.expectedRevision) throw new HomeAiError('CONFLICT',`诊断已更新到修订号 ${row.revision}；请用 home_ai_session_open(sessionId) 重新读取，再基于最新内容修改。`);
      const state=row.state;
      if(name==='home_ai_opportunity_discover') return sessionView(row.id,row.revision,state);
      if(name==='home_ai_report_build') return {...sceneReport(state,args.stageId),sessionId:row.id,revision:row.revision};
      if(name==='home_ai_interview_update') {
        const q=QUESTIONS.find(q=>q.id===args.answerId)!;
        record(state,q,args.answer);state.profileConfirmed=false;
      } else if(name==='home_ai_conditions_update') {
        sceneFor(args.stageId);invalidateScene(state,args.stageId);state.selected=args.stageId;
        const a=assessment(state,args.stageId);
        Object.assign(a.checks,args.checks);Object.assign(a.notes,args.notes);Object.assign(a,args.reportEdits??{});
      } else if(name==='home_ai_value_estimate') {
        sceneFor(args.stageId);invalidateScene(state,args.stageId);state.selected=args.stageId;
        const a=assessment(state,args.stageId);Object.assign(a.numbers,args.numbers);
        if(args.source) a.source=args.source;
        if(args.targetHours!==undefined) a.target=args.targetHours;
        const v=valueEstimate(a.numbers);if(v.error) throw new HomeAiError('INVALID_ARGUMENT',`${v.error} 请修正 numbers 后重新调用；未保存本次修改。`);
      } else if(name==='home_ai_materials_add') {
        if(state.documents.some((doc:any)=>doc.id===args.fileId)) return sessionView(row.id,row.revision,state);
        if(state.documents.length>=8) throw new HomeAiError('INVALID_ARGUMENT','最多关联8份材料，请创建新诊断或减少材料数量。');
        const file=await accessibleFile(this.pool,scope.identityId,args.fileId);
        if(!file||file.conversation_id!==scope.conversationId||file.status!=='uploaded') throw new HomeAiError('NOT_FOUND','材料不属于当前群聊或未上传完成；请重新上传并使用返回的 fileId。');
        if(Number(file.size_bytes)>8*1024*1024) throw new HomeAiError('INVALID_ARGUMENT','材料超过8 MiB，请拆分后重新上传。');
        const bytes=await this.objectStore?.get(file.storage_key);
        if(!bytes) throw new HomeAiError('NOT_FOUND','材料文件不可读取，请重新上传；确认对象存储服务可用。');
        const parsed=await parseMaterial(file.name,bytes);
        invalidate(state);state.documents.push({...parsed,id:args.fileId,provenance:{type:'platform_attachment'}});
        state.documentsRevision++;for(const a of Object.values(state.scenes) as any[]) a.checks.evidence='unknown';
      }
      // One SQL revision is authoritative; legacy invalidation may also increment its own counter.
      state.revision=row.revision+1;
      if(Buffer.byteLength(JSON.stringify(state))>4*1024*1024) throw new HomeAiError('INVALID_ARGUMENT','诊断材料累计超过4 MiB，请拆分成多次诊断；本次修改未保存。');
      await client.query('UPDATE home_ai_sessions SET state=$2,revision=revision+1,updated_at=now() WHERE id=$1',[row.id,JSON.stringify(state)]);
      return sessionView(row.id,row.revision+1,state);
    });
  }
  async confirm(scope:DiagnosticScope,sessionId:string,raw:unknown,operationKey:string) {
    const args=homeAiConfirmationSchema.parse(raw);
    await requirePermission(this.pool,scope.identityId,'write');
    return this.transaction(scope,`human:${operationKey}`,{sessionId,args},async client=>{
      const row=await this.load(client,scope,sessionId,true);
      if(row.revision!==args.expectedRevision) throw new HomeAiError('CONFLICT','内容已变化，请刷新诊断并重新核对后确认。');
      if(args.kind==='profile') {
        if(!row.state.answers.role||!row.state.answers.mission) throw new HomeAiError('INVALID_ARGUMENT','请先补充岗位和职责，再核对岗位画像。');
        row.state.profileConfirmed=true;
      } else {
        if(!canConfirm(row.state,args.stageId!)) throw new HomeAiError('INVALID_ARGUMENT','请先确认岗位画像，补齐四项试点条件及有效测算；I/C/D 场景只能导出讨论稿。');
        row.state.confirmedScenes[args.stageId!]={confirmedAt:new Date().toISOString(),revision:row.revision+1};
        row.state.selected=args.stageId;row.state.accepted=true;
      }
      row.state.revision=row.revision+1;
      await client.query('UPDATE home_ai_sessions SET state=$2,revision=revision+1,updated_at=now() WHERE id=$1',[sessionId,JSON.stringify(row.state)]);
      return sessionView(row.id,row.revision+1,row.state);
    });
  }
  private async transaction(scope:DiagnosticScope,key:string,input:unknown,operation:(client:PoolClient)=>Promise<any>) {
    const client=await this.pool.connect();const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const reusable=key!=='tool:';
    try {
      await client.query('BEGIN');await this.authorize(client,scope);
      if(reusable) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${scope.identityId}:${scope.conversationId}:${key}`]);
        const previous=(await client.query('SELECT input_hash,result FROM home_ai_operations WHERE identity_id=$1 AND conversation_id=$2 AND operation_key=$3',
          [scope.identityId,scope.conversationId,key])).rows[0];
        if(previous) {
          if(previous.input_hash!==hash) throw new HomeAiError('CONFLICT','同一调用编号不能提交不同参数，请创建新的请求编号。');
          await client.query('COMMIT');return previous.result;
        }
      }
      const result=await operation(client);
      if(reusable) await client.query('INSERT INTO home_ai_operations(identity_id,conversation_id,operation_key,input_hash,result) VALUES($1,$2,$3,$4,$5)',
        [scope.identityId,scope.conversationId,key,hash,JSON.stringify(result)]);
      await client.query('COMMIT');return result;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
}
