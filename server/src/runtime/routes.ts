import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { agentDefinitionInputSchema, agentDefinitionPatchSchema, deviceRegistrationSchema, runtimeSkillCatalog, toolReceiptSchema } from '@kla-workstation/contracts';
import type { AccountRepository } from '../repositories/types.js';
import { requirePermission, type PermissionAction } from '../auth/permission-service.js';
import { ensureRuntimeRegistry } from './registry.js';
import { parseToolArguments } from './tools.js';
import type { AgentLoopWorker } from '../infrastructure/agent-loop.js';

export async function registerRuntimeRoutes(app: FastifyInstance, deps: {pool:Pool;accounts:AccountRepository;worker:AgentLoopWorker}) {
  const {pool,accounts,worker}=deps;
  async function scope(request:FastifyRequest,reply:FastifyReply,action:PermissionAction='read') {
    const session=await accounts.getSession((request.headers.authorization??'').replace(/^Bearer /,''));
    if(!session){reply.code(401).send({ok:false,error:{code:'UNAUTHENTICATED',message:'请先登录'}});return null;}
    const identity=(await accounts.listIdentities(session.userId)).find(i=>i.id===request.headers['x-identity-id']&&i.status==='active');
    if(!identity){reply.code(403).send({ok:false,error:{code:'IDENTITY_REQUIRED',message:'当前身份不可用'}});return null;}
    await requirePermission(pool,identity.id,action);return{identity,session};
  }
  const id=(value:unknown)=>z.string().uuid().parse(value);
  async function device(request:FastifyRequest,reply:FastifyReply) {
    const s=await scope(request,reply,'execute');if(!s)return null;
    const deviceId=id((request.params as {deviceId:string}).deviceId);
    const d=(await pool.query('SELECT * FROM execution_devices WHERE id=$1 AND identity_id=$2 AND session_id=$3 AND enabled',[deviceId,s.identity.id,s.session.id])).rows[0];
    if(!d){reply.code(404).send({ok:false,error:{code:'DEVICE_NOT_FOUND',message:'设备未注册到当前身份和会话'}});return null;}return{...s,device:d};
  }
  async function validateDevice(deviceId:string|null|undefined,identityId:string) {
    if(deviceId&&!(await pool.query('SELECT id FROM execution_devices WHERE id=$1 AND identity_id=$2',[deviceId,identityId])).rows[0])throw app.httpErrors.badRequest('执行设备不属于当前身份');
  }
  app.post('/api/v1/agents',async(request,reply)=>{
    const s=await scope(request,reply,'write');if(!s)return;const b=agentDefinitionInputSchema.parse(request.body);
    if(b.name==='统筹智能体')throw app.httpErrors.conflict('统筹智能体由系统管理');await validateDevice(b.deviceId,s.identity.id);
    const a=(await pool.query('INSERT INTO agents(identity_id,name,role,model_id,execution_location,device_id,enabled) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[s.identity.id,b.name,b.role,b.modelId??null,b.executionLocation,b.executionLocation==='local'?b.deviceId??null:null,b.enabled])).rows[0];
    await ensureRuntimeRegistry(pool,s.identity.id);return reply.code(201).send({ok:true,data:a});
  });
  app.patch('/api/v1/agents/:agentId',async(request,reply)=>{
    const s=await scope(request,reply,'write');if(!s)return;const agentId=id((request.params as {agentId:string}).agentId);const b=agentDefinitionPatchSchema.parse(request.body);
    const client=await pool.connect();try{await client.query('BEGIN');const a=(await client.query('SELECT * FROM agents WHERE id=$1 AND identity_id=$2 FOR UPDATE',[agentId,s.identity.id])).rows[0];
      if(!a)throw app.httpErrors.notFound('智能体不存在');if(a.name==='统筹智能体'&&(b.name&&b.name!==a.name||b.executionLocation==='local'||b.deviceId||b.enabled===false))throw app.httpErrors.badRequest('统筹智能体固定在服务端且必须启用');
      if(b.name==='统筹智能体'&&a.name!==b.name)throw app.httpErrors.badRequest('统筹名称保留');await validateDevice(b.deviceId,s.identity.id);
      const location=b.executionLocation??a.execution_location;const updated=(await client.query('UPDATE agents SET name=$2,role=$3,model_id=$4,execution_location=$5,device_id=$6,enabled=$7,version=version+1 WHERE id=$1 RETURNING *',[agentId,b.name??a.name,b.role??a.role,b.modelId===undefined?a.model_id:b.modelId,location,location==='local'?(b.deviceId===undefined?a.device_id:b.deviceId):null,b.enabled??a.enabled])).rows[0];await client.query('COMMIT');return{ok:true,data:updated};
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  });
  app.patch('/api/v1/skills/:skillId',async(request,reply)=>{
    const s=await scope(request,reply,'write');if(!s)return;const b=z.object({enabled:z.boolean()}).parse(request.body);
    const r=await pool.query('UPDATE skills s SET enabled=$3,version=s.version+1 FROM agents a WHERE s.id=$1 AND a.id=s.agent_id AND a.identity_id=$2 RETURNING s.*',[id((request.params as {skillId:string}).skillId),s.identity.id,b.enabled]);
    if(!r.rows[0])throw app.httpErrors.notFound('技能不存在');return{ok:true,data:r.rows[0]};
  });
  app.get('/api/v1/runtime/tools',async(request,reply)=>{
    const s=await scope(request,reply);if(!s)return;
    await ensureRuntimeRegistry(pool,s.identity.id);
    const skills=await pool.query(`SELECT s.definition->>'code' AS code,a.id AS agent_id,a.name AS agent_name,
      s.enabled AND a.enabled AS enabled,a.execution_location,a.device_id FROM skills s JOIN agents a ON a.id=s.agent_id WHERE a.identity_id=$1 AND s.definition ? 'code'`,[s.identity.id]);
    const devices=await pool.query(`SELECT d.id,d.capabilities FROM execution_devices d JOIN sessions sess ON sess.id=d.session_id
      WHERE d.identity_id=$1 AND d.enabled AND d.last_seen_at>now()-interval '20 seconds' AND sess.revoked_at IS NULL AND sess.expires_at>now()`,[s.identity.id]);
    return{ok:true,data:runtimeSkillCatalog.map(tool=>({code:tool.code,name:tool.name,description:tool.description,location:tool.location,
      agents:skills.rows.filter(row=>row.code===tool.code).map(row=>({id:row.agent_id,name:row.agent_name,
        enabled:row.enabled&&(tool.location==='server'||row.execution_location==='local'),
        deviceOnline:tool.location==='local'?devices.rows.some(device=>device.capabilities.includes(tool.code)&&(!row.device_id||row.device_id===device.id)):null})),
      deviceOnline:tool.location==='local'?devices.rows.some(device=>device.capabilities.includes(tool.code)):null}))};
  });
  app.get('/api/v1/runtime/devices',async(request,reply)=>{const s=await scope(request,reply);if(!s)return;return{ok:true,data:(await pool.query(`SELECT d.id,d.name,d.platform,d.capabilities,d.enabled,d.last_seen_at,(d.enabled AND d.last_seen_at>now()-interval '20 seconds' AND s.revoked_at IS NULL AND s.expires_at>now()) AS online FROM execution_devices d JOIN sessions s ON s.id=d.session_id WHERE d.identity_id=$1 ORDER BY d.last_seen_at DESC`,[s.identity.id])).rows};});
  app.post('/api/v1/runtime/devices',async(request,reply)=>{
    const s=await scope(request,reply,'execute');if(!s)return;const b=deviceRegistrationSchema.parse(request.body);
    const d=(await pool.query(`INSERT INTO execution_devices(identity_id,session_id,installation_id,name,platform,capabilities) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(identity_id,installation_id) DO UPDATE SET session_id=EXCLUDED.session_id,name=EXCLUDED.name,capabilities=EXCLUDED.capabilities,enabled=true,last_seen_at=now() RETURNING id`,[s.identity.id,s.session.id,b.installationId,b.name,b.platform,JSON.stringify(b.capabilities)])).rows[0];return{ok:true,data:d};
  });
  app.delete('/api/v1/runtime/devices/:deviceId/connection',async(request,reply)=>{const s=await device(request,reply);if(!s)return;await pool.query('UPDATE execution_devices SET enabled=false WHERE id=$1',[s.device.id]);return{ok:true,data:null};});
  app.post('/api/v1/runtime/devices/:deviceId/poll',async(request,reply)=>{
    const s=await device(request,reply);if(!s)return;
    const client=await pool.connect();
    try { await client.query('BEGIN'); await client.query('SELECT id FROM execution_devices WHERE id=$1 FOR UPDATE',[s.device.id]); await client.query('UPDATE execution_devices SET last_seen_at=now() WHERE id=$1',[s.device.id]);
    // Grants are rechecked at dispatch, not only when the model requested a tool.
    await client.query(`UPDATE runtime_tool_calls t SET status='cancelled',result='{"error":"本地工具授权已撤销"}',completed_at=now()
      WHERE t.device_id=$1 AND t.status IN('queued','running') AND NOT EXISTS(
        SELECT 1 FROM conversation_run_steps st JOIN agents a ON a.id=st.assigned_agent_id
        JOIN skills sk ON sk.agent_id=a.id AND sk.enabled AND sk.definition->>'code'=t.tool_name
        WHERE st.id=t.step_id AND a.identity_id=t.identity_id AND a.enabled AND a.execution_location='local')`,[s.device.id]);
    const cancelled=(await client.query("SELECT id FROM runtime_tool_calls WHERE device_id=$1 AND status IN('cancelled','unknown') AND created_at>now()-interval '1 day'",[s.device.id])).rows.map(r=>r.id);
    const call=(await client.query(`WITH next AS(SELECT t.id FROM runtime_tool_calls t JOIN conversation_run_steps st ON st.id=t.step_id JOIN conversation_runs r ON r.id=st.run_id JOIN agents a ON a.id=st.assigned_agent_id
      JOIN skills sk ON sk.agent_id=a.id AND sk.enabled AND sk.definition->>'code'=t.tool_name
      WHERE t.device_id=$1 AND t.identity_id=$2 AND t.status='queued' AND r.status IN('running','waiting_tool') AND t.tool_name=ANY($3::text[])
      AND a.enabled AND a.identity_id=$2 AND a.execution_location='local'
      AND NOT EXISTS(SELECT 1 FROM runtime_tool_calls busy WHERE busy.device_id=$1 AND busy.status='running') ORDER BY t.created_at,t.id FOR UPDATE OF t SKIP LOCKED LIMIT 1)
      UPDATE runtime_tool_calls t SET status='running',dispatched_at=now() FROM next WHERE t.id=next.id RETURNING t.*`,[s.device.id,s.identity.id,s.device.capabilities])).rows[0];
    if(call){call.arguments=parseToolArguments(call.tool_name,call.arguments);const st=(await client.query('SELECT st.run_id,r.conversation_id FROM conversation_run_steps st JOIN conversation_runs r ON r.id=st.run_id WHERE st.id=$1',[call.step_id])).rows[0];await client.query("INSERT INTO runtime_events(identity_id,conversation_id,run_id,kind,payload) VALUES($1,$2,$3,'tool.dispatched',$4)",[s.identity.id,st.conversation_id,st.run_id,JSON.stringify({callId:call.id,tool:call.tool_name,deviceId:s.device.id})]);await client.query('COMMIT');return{ok:true,data:{call:{id:call.id,tool:call.tool_name,arguments:call.arguments,stepId:call.step_id,runId:st.run_id},cancelled}};}await client.query('COMMIT');return{ok:true,data:{call:null,cancelled}};
    // 该路由的请求日志被 observability/logger.ts 的 shouldQuietRequestLogging（logController.
    // disableRequestLogging）降噪（本地运行时每 2 秒一次心跳，会淹没业务日志），
    // 且降噪会连失败态的自动日志一起压掉，因此失败必须在这里显式补一条，否则故障会被静默。
    } catch(error) { request.log.error({ err: error, deviceId: s.device.id }, 'runtime device poll failed'); await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });
  app.post('/api/v1/runtime/devices/:deviceId/calls/:callId/receipt',{bodyLimit:4*1024*1024},async(request,reply)=>{
    const s=await device(request,reply);if(!s)return;const callId=id((request.params as {callId:string}).callId);const b=toolReceiptSchema.parse(request.body);
    const client=await pool.connect();try{await client.query('BEGIN');const call=(await client.query(`SELECT t.*,st.run_id,r.conversation_id,r.status AS run_status FROM runtime_tool_calls t JOIN conversation_run_steps st ON st.id=t.step_id JOIN conversation_runs r ON r.id=st.run_id WHERE t.id=$1 AND t.device_id=$2 AND t.identity_id=$3 FOR UPDATE OF t,r`,[callId,s.device.id,s.identity.id])).rows[0];
      if(!call)throw app.httpErrors.notFound('工具调用不存在');if(call.receipt_id){if(call.receipt_id!==b.receiptId)throw app.httpErrors.conflict('调用已提交其他回执');await client.query('COMMIT');return{ok:true,data:call.result};}
      if(call.status!=='running'||['cancelled','failed','completed'].includes(call.run_status))throw app.httpErrors.conflict('任务已结束或调用未被领取');
      if(b.status==='completed'&&!b.approval.approved)throw app.httpErrors.badRequest('未经本地用户审批的操作不能提交成功回执');
      let result={...b.result};if(b.artifact){if(b.status!=='completed'||!['local_write','local_code'].includes(call.tool_name))throw app.httpErrors.badRequest('此调用不接受成果');const a=b.artifact;if(createHash('sha256').update(a.content).digest('hex')!==a.checksum)throw app.httpErrors.badRequest('成果校验和不一致');
        const artifact=(await client.query('INSERT INTO artifacts(identity_id,conversation_id,name,mime_type,content,size_bytes,checksum,source_device_id,tool_call_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[s.identity.id,call.conversation_id,a.fileName,a.mimeType,a.content,Buffer.byteLength(a.content),a.checksum,s.device.id,callId])).rows[0];result={...result,artifactId:artifact.id,checksum:a.checksum};}
      await client.query('UPDATE runtime_tool_calls SET status=$2,result=$3,receipt_id=$4,completed_at=now() WHERE id=$1',[callId,b.status,JSON.stringify(result),b.receiptId]);await client.query('INSERT INTO runtime_events(identity_id,conversation_id,run_id,kind,payload) VALUES($1,$2,$3,$4,$5)',[s.identity.id,call.conversation_id,call.run_id,'tool.receipt',JSON.stringify({callId,deviceId:s.device.id,status:b.status,artifactId:result.artifactId,approval:b.approval??null})]);await client.query('COMMIT');worker.kick();return{ok:true,data:result};
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  });
  app.get('/api/v1/runtime/events',async(request,reply)=>{const s=await scope(request,reply);if(!s)return;const q=z.object({after:z.coerce.number().int().min(0).default(0),conversationId:z.string().uuid().optional()}).parse(request.query);return{ok:true,data:(await pool.query('SELECT sequence,conversation_id,run_id,kind,payload,created_at FROM runtime_events WHERE identity_id=$1 AND sequence>$2 AND ($3::uuid IS NULL OR conversation_id=$3) ORDER BY sequence LIMIT 200',[s.identity.id,q.after,q.conversationId??null])).rows};});
  app.get('/api/v1/artifacts/:artifactId/download',async(request,reply)=>{const s=await scope(request,reply,'export');if(!s)return;const a=await accounts.getArtifact(s.identity.id,id((request.params as {artifactId:string}).artifactId));if(!a)throw app.httpErrors.notFound('成果不存在');return reply.header('content-disposition',`attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`).type(a.mimeType).send(a.content);});
}
