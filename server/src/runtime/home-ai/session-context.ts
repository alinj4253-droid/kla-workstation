import type { Pool, PoolClient } from 'pg';
import { HomeAiService } from './service.js';
import { sessionView } from './domain.js';
import { HomeAiError, assertBindingVersion, lockCurrentBinding, readCurrentBinding } from './session-binding.js';
import { HOME_AI_TEMPLATE_CODE } from './agent.js';
import { accessibleFile } from '../../storage/file-access.js';

export type HomeAiContextScope = { identityId: string; conversationId: string; stepId: string; agentId?: string; runId?: string };
export type HomeAiExecutionPin = { sessionId: string | null; bindingVersion: number; fresh?: boolean };
type ContextMessage = { role: 'system'|'user'|'assistant'; content: string };

/** Server-only adapter: a step's immutable role epoch controls all context/resources. */
export class HomeAiSessionContext {
  constructor(private readonly pool: Pool) {}
  private async step(client:Pool|PoolClient,scope:HomeAiContextScope,lock=false) {
    const row=(await client.query(`SELECT s.*,r.trigger_message_id FROM conversation_run_steps s
      JOIN conversation_runs r ON r.id=s.run_id JOIN conversations c ON c.id=r.conversation_id
      JOIN projects p ON p.id=c.project_id AND p.owner_identity_id=$1
      JOIN identities i ON i.id=p.owner_identity_id AND i.status='active'
      JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.identity_id=i.id
      JOIN project_members pm ON pm.project_id=p.id AND pm.identity_id=i.id
      JOIN agents a ON a.id=s.assigned_agent_id AND a.identity_id=i.id AND a.enabled
      JOIN agent_market_installations installation ON installation.agent_id=a.id AND installation.identity_id=i.id AND installation.template_code=$6
      JOIN conversation_agents ca ON ca.agent_id=a.id AND ca.conversation_id=c.id
      WHERE s.id=$3 AND c.id=$2 AND ($4::uuid IS NULL OR a.id=$4) AND ($5::uuid IS NULL OR r.id=$5)${lock?' FOR UPDATE OF s':''}`, [scope.identityId,scope.conversationId,scope.stepId,scope.agentId??null,scope.runId??null,HOME_AI_TEMPLATE_CODE])).rows[0];
    if(!row)throw new HomeAiError('NOT_FOUND','当前身份与群聊未找到此诊断执行。');
    return row;
  }
  private async saved(client:Pool|PoolClient,scope:HomeAiContextScope) {
    const row=(await client.query(`SELECT session_id,binding_version,trigger_message_id FROM home_ai_execution_bindings
      WHERE step_id=$3 AND identity_id=$1 AND conversation_id=$2`,[scope.identityId,scope.conversationId,scope.stepId])).rows[0];
    if(!row)return null;
    const bindingVersion=Number(row.binding_version);
    if(!Number.isSafeInteger(bindingVersion))throw new HomeAiError('CONFLICT','当前诊断执行版本无效，请重新发起任务。');
    return {sessionId:row.session_id as string|null,bindingVersion,triggerMessageId:row.trigger_message_id as string};
  }
  async pin(scope:HomeAiContextScope & {triggerMessageId:string}):Promise<HomeAiExecutionPin> {
    const step=await this.step(this.pool,scope);
    if(step.trigger_message_id!==scope.triggerMessageId)throw new HomeAiError('CONFLICT','当前诊断触发消息已变化，请重新发起任务。');
    const existing=await this.saved(this.pool,scope);
    if(existing)return {sessionId:existing.sessionId,bindingVersion:existing.bindingVersion,fresh:false};
    if((Array.isArray(step.transcript)&&step.transcript.length)||(await this.pool.query('SELECT 1 FROM runtime_tool_calls WHERE step_id=$1 LIMIT 1',[scope.stepId])).rows[0])throw new HomeAiError('CONFLICT','旧诊断执行缺少岗位绑定，请重新发起任务。');
    const current=await new HomeAiService(this.pool).openCurrent(scope);
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN');const binding=await lockCurrentBinding(client,scope);
      assertBindingVersion(binding,current.bindingVersion);
      const locked=await this.step(client,scope,true),saved=await this.saved(client,scope);
      if(saved){await client.query('COMMIT');return {sessionId:saved.sessionId,bindingVersion:saved.bindingVersion,fresh:false};}
      if((Array.isArray(locked.transcript)&&locked.transcript.length)||(await client.query('SELECT 1 FROM runtime_tool_calls WHERE step_id=$1 LIMIT 1',[scope.stepId])).rows[0])throw new HomeAiError('CONFLICT','旧诊断执行缺少岗位绑定，请重新发起任务。');
      await client.query(`INSERT INTO home_ai_execution_bindings(step_id,identity_id,conversation_id,session_id,binding_version,trigger_message_id)
        VALUES($1,$2,$3,$4,$5,$6)`,[scope.stepId,scope.identityId,scope.conversationId,current.session?.sessionId??null,current.bindingVersion,scope.triggerMessageId]);
      if(current.session)await this.linkMessage(scope,scope.triggerMessageId,client);
      await client.query('COMMIT');return {sessionId:current.session?.sessionId??null,bindingVersion:current.bindingVersion,fresh:true};
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  async assertCurrent(scope:HomeAiContextScope,client?:PoolClient):Promise<HomeAiExecutionPin> {
    const queryable=client??this.pool;
    const binding=client?await lockCurrentBinding(client,scope):await readCurrentBinding(queryable,scope);
    await this.step(queryable,scope);
    const saved=await this.saved(queryable,scope);
    if(!saved)throw new HomeAiError('CONFLICT','当前诊断执行缺少岗位绑定，请重新发起任务。');
    assertBindingVersion(binding,saved.bindingVersion);
    if((binding?.sessionId??null)!==saved.sessionId)throw new HomeAiError('CONFLICT','当前岗位诊断已切换，请重新发起任务。');
    return {sessionId:saved.sessionId,bindingVersion:saved.bindingVersion};
  }
  async withCurrent<T>(scope:HomeAiContextScope,operation:(client:PoolClient,pin:HomeAiExecutionPin)=>Promise<T>):Promise<T> {
    const client=await this.pool.connect();
    try{await client.query('BEGIN');const pin=await this.assertCurrent(scope,client);const result=await operation(client,pin);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  async linkMessage(scope:HomeAiContextScope,messageId:string,client?:PoolClient):Promise<void> {
    if(!client)return this.withCurrent(scope,c=>this.linkMessage(scope,messageId,c));
    const pin=await this.assertCurrent(scope,client);if(!pin.sessionId)throw new HomeAiError('CONFLICT','请先在界面选择当前岗位诊断。');
    const saved=await this.saved(client,scope);
    const message=(await client.query(`SELECT m.id FROM messages m JOIN conversation_run_steps s ON s.id=$3 JOIN identities i ON i.id=$1
      WHERE m.id=$4 AND m.conversation_id=$2 AND
      ((m.sender_type='user' AND m.id=$5) OR (m.sender_type='agent' AND m.metadata->>'runStepId'=$3::text))`,
    [scope.identityId,scope.conversationId,scope.stepId,messageId,saved!.triggerMessageId])).rows[0];
    if(!message)throw new HomeAiError('NOT_FOUND','当前身份与群聊未找到此诊断消息。');
    await client.query(`INSERT INTO home_ai_session_messages(identity_id,conversation_id,session_id,message_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[scope.identityId,scope.conversationId,pin.sessionId,messageId]);
    const linked=(await client.query('SELECT session_id FROM home_ai_session_messages WHERE identity_id=$1 AND conversation_id=$2 AND message_id=$3',[scope.identityId,scope.conversationId,messageId])).rows[0];
    if(linked?.session_id!==pin.sessionId)throw new HomeAiError('CONFLICT','该消息已属于另一岗位诊断，请重新发送当前岗位信息。');
  }
  async messages(scope:HomeAiContextScope):Promise<ContextMessage[]> {
    return this.withCurrent(scope,async(client,pin)=>{
      if(!pin.sessionId)return [{role:'system',content:'尚未选择当前岗位诊断；请用户在诊断面板选择历史岗位，不能猜测或自动合并。'}];
      const row=(await client.query('SELECT id,revision,state FROM home_ai_sessions WHERE id=$1 AND identity_id=$2 AND conversation_id=$3',[pin.sessionId,scope.identityId,scope.conversationId])).rows[0];
      if(!row)throw new HomeAiError('NOT_FOUND','当前身份与群聊未找到此诊断。');
      const saved=await this.saved(client,scope);
      const rows=(await client.query(`SELECT m.sender_type,m.text,m.metadata FROM home_ai_session_messages sm JOIN messages m ON m.id=sm.message_id
        JOIN messages trigger ON trigger.id=$4 AND trigger.conversation_id=m.conversation_id
        WHERE sm.identity_id=$1 AND sm.conversation_id=$2 AND sm.session_id=$3
        AND m.created_at<=trigger.created_at ORDER BY m.created_at DESC,m.id DESC LIMIT 20`,[scope.identityId,scope.conversationId,pin.sessionId,saved!.triggerMessageId])).rows;
      const result:ContextMessage[]=[{role:'system',content:`当前岗位诊断权威状态（仅此会话；包含完整已保存访谈，不能从截断聊天重建事实；accepted与profileConfirmed仅以服务端状态为准）：${JSON.stringify({bindingVersion:pin.bindingVersion,...sessionView(row.id,row.revision,row.state)})}`}];
      for(const message of rows.reverse()){
        result.push({role:message.sender_type==='user'?'user':'assistant',content:message.text.slice(0,6000)});
        if(message.sender_type==='user'&&Array.isArray(message.metadata?.files))result.push({role:'system',content:`当前岗位用户提供的附件：${JSON.stringify(message.metadata.files.map((file:Record<string,unknown>)=>({id:file.id,name:file.name,contentType:file.contentType,sizeBytes:file.sizeBytes})))}`});
      }
      return result;
    });
  }
  async recall(scope:HomeAiContextScope,query:string):Promise<string[]> {
    return this.withCurrent(scope,async(client,pin)=>{
      if(!pin.sessionId)return [];
      const saved=await this.saved(client,scope);
      const rows=(await client.query(`SELECT m.text FROM home_ai_session_messages sm JOIN messages m ON m.id=sm.message_id
        JOIN messages trigger ON trigger.id=$5 AND trigger.conversation_id=m.conversation_id
        WHERE sm.identity_id=$1 AND sm.conversation_id=$2 AND sm.session_id=$3 AND position(lower($4) in lower(m.text))>0
        AND m.created_at<=trigger.created_at ORDER BY m.created_at DESC,m.id DESC LIMIT 3`,[scope.identityId,scope.conversationId,pin.sessionId,query.trim().slice(0,240),saved!.triggerMessageId])).rows;
      return rows.map(row=>String(row.text).slice(0,400));
    });
  }
  async assertFile(scope:HomeAiContextScope,fileId:string,client?:PoolClient):Promise<void> {
    if(!client)return this.withCurrent(scope,c=>this.assertFile(scope,fileId,c));
    const pin=await this.assertCurrent(scope,client);
    const file=await accessibleFile(client,scope.identityId,fileId);
    if(!file||file.conversation_id!==scope.conversationId||file.status!=='uploaded')throw new HomeAiError('FORBIDDEN','当前身份与群聊未找到此附件。');
    const allowed=pin.sessionId&&(await client.query(`SELECT 1 FROM files f WHERE f.id=$4 AND f.conversation_id=$2 AND f.status='uploaded'
      AND (EXISTS(SELECT 1 FROM home_ai_session_messages sm JOIN messages m ON m.id=sm.message_id
        WHERE sm.identity_id=$1 AND sm.conversation_id=$2 AND sm.session_id=$3 AND m.sender_type='user'
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.metadata->'files')='array' THEN m.metadata->'files' ELSE '[]'::jsonb END) AS ref WHERE ref->>'id'=$4::text))
      OR EXISTS(SELECT 1 FROM home_ai_sessions hs WHERE hs.id=$3 AND hs.identity_id=$1 AND hs.conversation_id=$2
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(hs.state->'documents') AS doc WHERE doc->>'id'=$4::text)))`,[scope.identityId,scope.conversationId,pin.sessionId,fileId])).rows[0];
    if(!allowed)throw new HomeAiError('FORBIDDEN','该附件未关联当前岗位诊断，请用户为当前岗位明确提供附件。');
  }
  async assertArtifact(scope:HomeAiContextScope,artifactId:string,client?:PoolClient):Promise<void> {
    if(!client)return this.withCurrent(scope,c=>this.assertArtifact(scope,artifactId,c));
    const pin=await this.assertCurrent(scope,client);
    const allowed=pin.sessionId&&(await client.query(`SELECT 1 FROM home_ai_session_artifacts sa JOIN artifacts a ON a.id=sa.artifact_id
      WHERE sa.identity_id=$1 AND sa.conversation_id=$2 AND sa.session_id=$3 AND sa.artifact_id=$4 AND a.identity_id=$1 AND a.conversation_id=$2`,[scope.identityId,scope.conversationId,pin.sessionId,artifactId])).rows[0];
    if(!allowed)throw new HomeAiError('FORBIDDEN','该成果未关联当前岗位诊断，请委派原岗位诊断处理。');
  }
  async recordArtifact(scope:HomeAiContextScope,artifactId:string,client?:PoolClient):Promise<void> {
    if(!client)return this.withCurrent(scope,c=>this.recordArtifact(scope,artifactId,c));
    const pin=await this.assertCurrent(scope,client);
    const row=pin.sessionId&&(await client.query(`SELECT a.id FROM artifacts a JOIN runtime_tool_calls t ON t.id=a.tool_call_id
      WHERE a.id=$4 AND a.identity_id=$1 AND a.conversation_id=$2 AND t.step_id=$3`,[scope.identityId,scope.conversationId,scope.stepId,artifactId])).rows[0];
    if(!row)throw new HomeAiError('FORBIDDEN','当前诊断执行未生成此成果。');
    await client.query(`INSERT INTO home_ai_session_artifacts(identity_id,conversation_id,session_id,artifact_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[scope.identityId,scope.conversationId,pin.sessionId,artifactId]);
    await this.assertArtifact(scope,artifactId,client);
  }
}
