import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { validateLocalArtifacts } from './local-artifacts.js';
import { z } from 'zod';
import { agentDefinitionInputSchema, agentDefinitionPatchSchema, deviceRegistrationSchema, runtimeSkillCatalog, toolReceiptSchema } from '@kla-workstation/contracts';
import type { AccountRepository } from '../repositories/types.js';
import { requirePermission, type PermissionAction } from '../auth/permission-service.js';
import { effectiveToolCodes, ensureRuntimeRegistry } from './registry.js';
import { parseToolArguments } from './tools.js';
import type { AgentLoopWorker } from '../infrastructure/agent-loop.js';
import type { ComputeRepository } from '../compute/compute-repository.js';
import type { Sub2ApiClient } from '../compute/sub2api-client.js';
import { resolveManagedPassword } from '../compute/encryption.js';
import type { ObjectStore } from '../storage/object-store.js';
import { accessibleFile } from '../storage/file-access.js';

export async function registerRuntimeRoutes(app: FastifyInstance, deps: {pool:Pool;accounts:AccountRepository;worker:AgentLoopWorker;computeRepo?:ComputeRepository;sub2api?:Sub2ApiClient;encryptionKey?:string;objectStore?:ObjectStore}) {
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
  async function validateModelMount(identityId:string,modelKeyId:string|null|undefined,modelId:string|null|undefined) {
    if (!modelKeyId) { if (modelId) throw app.httpErrors.badRequest('挂载模型前需先选择 API Key'); return; }
    if (!modelId) throw app.httpErrors.badRequest('选择 API Key 后还需选择模型');
    if (!deps.computeRepo || !deps.sub2api) throw app.httpErrors.serviceUnavailable('算力服务未配置');
    const key=await deps.computeRepo.getKey(modelKeyId,identityId);
    if (!key || key.status!=='active') throw app.httpErrors.badRequest('模型挂载 Key 不属于当前身份或已停用');
    const model=await deps.computeRepo.getCatalogModel(modelId);
    if (!model?.enabled) throw app.httpErrors.badRequest('模型不在平台可用目录中');
    const binding=await deps.computeRepo.getBinding(identityId);
    const password=resolveManagedPassword(binding?.managedPassword??null,deps.encryptionKey??'');
    if (!binding || !password) throw app.httpErrors.serviceUnavailable('当前身份算力账号不可用');
    const jwt=await deps.sub2api.getUserJwt(binding.sub2apiUserId,binding.sub2apiUsername,password);
    const secret=await deps.sub2api.resolveApiKeySecret(jwt,key.sub2apiKeyId);
    if (!secret) throw app.httpErrors.serviceUnavailable('该 Key 的上游凭据不可用');
    const available=await deps.sub2api.listModels(secret);
    if (!available.includes(modelId)) throw app.httpErrors.badRequest('此模型不在所选 Key 的可用模型中');
  }
  app.post('/api/v1/agents',async(request,reply)=>{
    const s=await scope(request,reply,'write');if(!s)return;const b=agentDefinitionInputSchema.parse(request.body);
    if(b.name==='统筹智能体')throw app.httpErrors.conflict('统筹智能体由系统管理');await validateDevice(b.deviceId,s.identity.id);
    await validateModelMount(s.identity.id,b.modelKeyId,b.modelId);
    const a=(await pool.query('INSERT INTO agents(identity_id,name,role,model_id,model_key_id,execution_location,device_id,enabled,model_mount_initialized) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[s.identity.id,b.name,b.role,b.modelId??null,b.modelKeyId??null,b.executionLocation,b.executionLocation==='local'?b.deviceId??null:null,b.enabled,Boolean(b.modelKeyId)])).rows[0];
    await ensureRuntimeRegistry(pool,s.identity.id);
    const agent=(await pool.query('SELECT * FROM agents WHERE id=$1 AND identity_id=$2',[a.id,s.identity.id])).rows[0];
    return reply.code(201).send({ok:true,data:agent});
  });
  app.patch('/api/v1/agents/:agentId',async(request,reply)=>{
    const s=await scope(request,reply,'write');if(!s)return;const agentId=id((request.params as {agentId:string}).agentId);const b=agentDefinitionPatchSchema.parse(request.body);
    const client=await pool.connect();try{await client.query('BEGIN');const a=(await client.query('SELECT * FROM agents WHERE id=$1 AND identity_id=$2 FOR UPDATE',[agentId,s.identity.id])).rows[0];
      if(!a)throw app.httpErrors.notFound('智能体不存在');if(a.name==='统筹智能体'&&(b.name&&b.name!==a.name||b.executionLocation==='local'||b.deviceId||b.enabled===false))throw app.httpErrors.badRequest('统筹智能体固定在服务端且必须启用');
      if(b.name==='统筹智能体'&&a.name!==b.name)throw app.httpErrors.badRequest('统筹名称保留');await validateDevice(b.deviceId,s.identity.id);
      const modelKeyId=b.modelKeyId===undefined?a.model_key_id:b.modelKeyId;
      if(b.modelKeyId!==undefined || b.modelId!==undefined) await validateModelMount(s.identity.id,modelKeyId,b.modelId===undefined?a.model_id:b.modelId);
      const location=b.executionLocation??a.execution_location;const updated=(await client.query('UPDATE agents SET name=$2,role=$3,model_id=$4,model_key_id=$5,execution_location=$6,device_id=$7,enabled=$8,model_mount_initialized=$9,version=version+1 WHERE id=$1 RETURNING *',[agentId,b.name??a.name,b.role??a.role,b.modelId===undefined?a.model_id:b.modelId,modelKeyId,location,location==='local'?(b.deviceId===undefined?a.device_id:b.deviceId):null,b.enabled??a.enabled,b.modelKeyId!==undefined||b.modelId!==undefined?true:a.model_mount_initialized])).rows[0];await client.query('COMMIT');return{ok:true,data:updated};
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  });
  app.patch('/api/v1/skills/:skillCode',async(request,reply)=>{
    const s=await scope(request,reply,'write');if(!s)return;const b=z.object({enabled:z.boolean()}).parse(request.body);
    const code=(request.params as {skillCode:string}).skillCode;
    const r=await pool.query('UPDATE runtime_skill_catalog SET enabled=$3 WHERE identity_id=$1 AND code=$2 RETURNING code,name,description,tool_codes,enabled',[s.identity.id,code,b.enabled]);
    if(!r.rows[0])throw app.httpErrors.notFound('技能不存在');return{ok:true,data:r.rows[0]};
  });
  app.get('/api/v1/agents/:agentId/capabilities', async (request, reply) => {
    const s = await scope(request, reply); if (!s) return;
    const agentId = id((request.params as { agentId: string }).agentId);
    const agent = (await pool.query('SELECT id FROM agents WHERE id=$1 AND identity_id=$2', [agentId, s.identity.id])).rows[0];
    if (!agent) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '智能体不存在' } });
    await ensureRuntimeRegistry(pool, s.identity.id);
    const [skills, direct, effective] = await Promise.all([
      pool.query(`SELECT c.code,c.name,c.description,c.tool_codes,m.agent_id IS NOT NULL AS mounted
        FROM runtime_skill_catalog c LEFT JOIN agent_skill_mounts m ON m.skill_code=c.code AND m.agent_id=$1
        WHERE c.identity_id=$2 AND c.enabled ORDER BY c.created_at,c.code`, [agentId, s.identity.id]),
      pool.query('SELECT tool_code FROM agent_tool_mounts WHERE agent_id=$1', [agentId]),
      effectiveToolCodes(pool, agentId),
    ]);
    return reply.send({ ok: true, data: { skills: skills.rows, tools: runtimeSkillCatalog.map(tool => ({ ...tool, mounted: direct.rows.some(row => row.tool_code === tool.code) })), effectiveTools: effective } });
  });
  app.put('/api/v1/agents/:agentId/capabilities', async (request, reply) => {
    const s = await scope(request, reply, 'write'); if (!s) return;
    const agentId = id((request.params as { agentId: string }).agentId);
    const body = z.object({ skillCodes: z.array(z.string()).default([]), toolCodes: z.array(z.string()).default([]) }).parse(request.body ?? {});
    const agent = (await pool.query('SELECT id FROM agents WHERE id=$1 AND identity_id=$2', [agentId, s.identity.id])).rows[0];
    if (!agent) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '智能体不存在' } });
    await ensureRuntimeRegistry(pool, s.identity.id);
    const knownSkills = new Set((await pool.query('SELECT code FROM runtime_skill_catalog WHERE identity_id=$1 AND enabled', [s.identity.id])).rows.map(row => row.code));
    const knownTools = new Set<string>(runtimeSkillCatalog.map(tool => tool.code));
    if (body.skillCodes.some(code => !knownSkills.has(code)) || body.toolCodes.some(code => !knownTools.has(code))) {
      return reply.code(400).send({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '技能或工具不在当前身份的能力目录中' } });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM agent_skill_mounts WHERE agent_id=$1', [agentId]);
      await client.query('DELETE FROM agent_tool_mounts WHERE agent_id=$1', [agentId]);
      for (const code of body.skillCodes) await client.query('INSERT INTO agent_skill_mounts(agent_id,skill_code) VALUES($1,$2)', [agentId, code]);
      for (const code of body.toolCodes) await client.query('INSERT INTO agent_tool_mounts(agent_id,tool_code) VALUES($1,$2)', [agentId, code]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return reply.send({ ok: true, data: { skills: body.skillCodes, tools: body.toolCodes, effectiveTools: await effectiveToolCodes(pool, agentId) } });
  });
  app.get('/api/v1/runtime/tools',async(request,reply)=>{
    const s=await scope(request,reply);if(!s)return;
    await ensureRuntimeRegistry(pool,s.identity.id);
    const devices=await pool.query(`SELECT d.id,d.capabilities FROM execution_devices d JOIN sessions sess ON sess.id=d.session_id
      WHERE d.identity_id=$1 AND d.enabled AND d.last_seen_at>now()-interval '20 seconds' AND sess.revoked_at IS NULL AND sess.expires_at>now()`,[s.identity.id]);
    return{ok:true,data:runtimeSkillCatalog.map(tool=>({code:tool.code,name:tool.name,description:tool.description,location:tool.location,
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
        WHERE st.id=t.step_id AND a.identity_id=t.identity_id AND a.enabled AND a.execution_location='local'
        AND (EXISTS(SELECT 1 FROM agent_tool_mounts m WHERE m.agent_id=a.id AND m.tool_code=t.tool_name)
          OR EXISTS(SELECT 1 FROM agent_skill_mounts m JOIN runtime_skill_catalog c
            ON c.identity_id=a.identity_id AND c.code=m.skill_code AND c.enabled
            WHERE m.agent_id=a.id AND t.tool_name=ANY(c.tool_codes))))`,[s.device.id]);
    const cancelled=(await client.query("SELECT id FROM runtime_tool_calls WHERE device_id=$1 AND status IN('cancelled','unknown') AND created_at>now()-interval '1 day'",[s.device.id])).rows.map(r=>r.id);
    const call=(await client.query(`WITH next AS(SELECT t.id FROM runtime_tool_calls t JOIN conversation_run_steps st ON st.id=t.step_id JOIN conversation_runs r ON r.id=st.run_id JOIN agents a ON a.id=st.assigned_agent_id
      WHERE t.device_id=$1 AND t.identity_id=$2 AND t.status='queued' AND r.status IN('running','waiting_tool') AND t.tool_name=ANY($3::text[])
      AND a.enabled AND a.identity_id=$2 AND a.execution_location='local'
      AND (EXISTS(SELECT 1 FROM agent_tool_mounts m WHERE m.agent_id=a.id AND m.tool_code=t.tool_name)
        OR EXISTS(SELECT 1 FROM agent_skill_mounts m JOIN runtime_skill_catalog c
          ON c.identity_id=a.identity_id AND c.code=m.skill_code AND c.enabled
          WHERE m.agent_id=a.id AND t.tool_name=ANY(c.tool_codes)))
      AND NOT EXISTS(SELECT 1 FROM runtime_tool_calls busy WHERE busy.device_id=$1 AND busy.status='running') ORDER BY t.created_at,t.id FOR UPDATE OF t SKIP LOCKED LIMIT 1)
      UPDATE runtime_tool_calls t SET status='running',dispatched_at=now() FROM next WHERE t.id=next.id RETURNING t.*`,[s.device.id,s.identity.id,s.device.capabilities])).rows[0];
    if(call){call.arguments=parseToolArguments(call.tool_name,call.arguments);const st=(await client.query('SELECT st.run_id,r.conversation_id FROM conversation_run_steps st JOIN conversation_runs r ON r.id=st.run_id WHERE st.id=$1',[call.step_id])).rows[0];await client.query("INSERT INTO runtime_events(identity_id,conversation_id,run_id,kind,payload) VALUES($1,$2,$3,'tool.dispatched',$4)",[s.identity.id,st.conversation_id,st.run_id,JSON.stringify({callId:call.id,tool:call.tool_name,deviceId:s.device.id})]);await client.query('COMMIT');return{ok:true,data:{call:{id:call.id,tool:call.tool_name,arguments:call.arguments,stepId:call.step_id,runId:st.run_id},cancelled}};}await client.query('COMMIT');return{ok:true,data:{call:null,cancelled}};
    // 该路由的请求日志被 observability/logger.ts 的 shouldQuietRequestLogging（logController.
    // disableRequestLogging）降噪（本地运行时每 2 秒一次心跳，会淹没业务日志），
    // 且降噪会连失败态的自动日志一起压掉，因此失败必须在这里显式补一条，否则故障会被静默。
    } catch(error) { request.log.error({ err: error, deviceId: s.device.id }, 'runtime device poll failed'); await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });
  app.post('/api/v1/runtime/devices/:deviceId/workspaces/status', async (request, reply) => {
    const s = await device(request, reply); if (!s) return;
    const body = z.object({ runIds: z.array(z.string().uuid()).max(200) }).parse(request.body);
    return { ok: true, data: (await pool.query(`SELECT DISTINCT r.id AS "runId",r.status FROM conversation_runs r
      JOIN conversation_run_steps st ON st.run_id=r.id JOIN runtime_tool_calls t ON t.step_id=st.id
      WHERE r.id=ANY($1::uuid[]) AND t.device_id=$2 AND t.identity_id=$3`, [body.runIds, s.device.id, s.identity.id])).rows };
  });
  app.get('/api/v1/runtime/devices/:deviceId/calls/:callId/input', async (request, reply) => {
    const s = await device(request, reply); if (!s) return;
    const call = (await pool.query(`SELECT t.*,r.conversation_id,r.status AS run_status FROM runtime_tool_calls t
      JOIN conversation_run_steps st ON st.id=t.step_id JOIN conversation_runs r ON r.id=st.run_id
      WHERE t.id=$1 AND t.device_id=$2 AND t.identity_id=$3`, [id((request.params as { callId: string }).callId), s.device.id, s.identity.id])).rows[0];
    if (!call || call.tool_name !== 'local_file_fetch' || call.status !== 'running' || !['running','waiting_tool'].includes(call.run_status)) throw app.httpErrors.notFound('文件下载调用不可用');
    const args = parseToolArguments(call.tool_name, call.arguments);
    let bytes: Buffer | null | undefined, name: string, mime: string, checksum: string | null;
    if (args.fileId) {
      const file = await accessibleFile(pool, s.identity.id, String(args.fileId));
      if (!file || file.conversation_id !== call.conversation_id) throw app.httpErrors.notFound('附件不属于当前群聊');
      bytes = await deps.objectStore?.get(file.storage_key); name = file.name; mime = file.content_type || 'application/octet-stream'; checksum = file.checksum;
    } else {
      const artifact = await accounts.getArtifact(s.identity.id, String(args.artifactId));
      if (!artifact || artifact.conversationId !== call.conversation_id) throw app.httpErrors.notFound('成果不属于当前群聊');
      bytes = artifact.storageKey ? await deps.objectStore?.get(artifact.storageKey) : Buffer.from(artifact.content, artifact.contentEncoding === 'base64' ? 'base64' : 'utf8');
      name = artifact.name; mime = artifact.mimeType; checksum = bytes ? createHash('sha256').update(bytes).digest('hex') : null;
    }
    if (!bytes) throw app.httpErrors.serviceUnavailable('共享文件对象不可用');
    return reply.header('cache-control', 'private, no-store').header('x-kla-file-name', encodeURIComponent(name)).header('x-kla-checksum', checksum ?? '').header('content-length', bytes.length).type(mime).send(bytes);
  });
  app.post('/api/v1/runtime/devices/:deviceId/calls/:callId/receipt',{bodyLimit:48*1024*1024},async(request,reply)=>{
    const s=await device(request,reply);if(!s)return;const callId=id((request.params as {callId:string}).callId);const b=toolReceiptSchema.parse(request.body);
    const client=await pool.connect();try{await client.query('BEGIN');const call=(await client.query(`SELECT t.*,st.run_id,r.conversation_id,r.status AS run_status FROM runtime_tool_calls t JOIN conversation_run_steps st ON st.id=t.step_id JOIN conversation_runs r ON r.id=st.run_id WHERE t.id=$1 AND t.device_id=$2 AND t.identity_id=$3 FOR UPDATE OF t,r`,[callId,s.device.id,s.identity.id])).rows[0];
      if(!call)throw app.httpErrors.notFound('工具调用不存在');if(call.receipt_id){if(call.receipt_id!==b.receiptId)throw app.httpErrors.conflict('调用已提交其他回执');await client.query('COMMIT');return{ok:true,data:call.result};}
      if(call.status!=='running'||['cancelled','failed','completed'].includes(call.run_status))throw app.httpErrors.conflict('任务已结束或调用未被领取');
      if(b.status==='completed'&&!b.approval.approved)throw app.httpErrors.badRequest('未经本地用户审批的操作不能提交成功回执');
      let files;try{files=validateLocalArtifacts(call.tool_name,b);}catch(error){throw app.httpErrors.badRequest((error as Error).message);}
      const result:Record<string,unknown>={...b.result};const artifactIds:string[]=[];
      for(const [index,a] of files.entries()){
        const artifact=(await client.query('INSERT INTO artifacts(identity_id,conversation_id,name,mime_type,content,content_encoding,size_bytes,checksum,source_device_id,tool_call_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',[s.identity.id,call.conversation_id,a.fileName,a.mimeType,a.content,a.contentEncoding,a.sizeBytes,a.checksum,s.device.id,index===0?callId:null])).rows[0];artifactIds.push(artifact.id);
        // Binary or large results are durable objects. Keep small text inline for
        // fast model access and backwards compatibility with old databases.
        if(deps.objectStore && (a.contentEncoding==='base64' || a.sizeBytes>256*1024)){
          const storageKey=`artifacts/${s.identity.id}/${artifact.id}/${a.fileName.replace(/[^\w.\-\u4e00-\u9fff]/g,'_')}`;
          const bytes=a.contentEncoding==='base64'?Buffer.from(a.content,'base64'):Buffer.from(a.content,'utf8');
          await deps.objectStore.put(storageKey,bytes);
          await client.query("UPDATE artifacts SET storage_key=$2,storage_status='stored',content='' WHERE id=$1",[artifact.id,storageKey]);
        }
      }
      if(artifactIds.length){result.artifactId=artifactIds[0];result.artifactIds=artifactIds;result.checksum=files[0].checksum;}
      await client.query('UPDATE runtime_tool_calls SET status=$2,result=$3,receipt_id=$4,completed_at=now() WHERE id=$1',[callId,b.status,JSON.stringify(result),b.receiptId]);await client.query('INSERT INTO runtime_events(identity_id,conversation_id,run_id,kind,payload) VALUES($1,$2,$3,$4,$5)',[s.identity.id,call.conversation_id,call.run_id,'tool.receipt',JSON.stringify({callId,deviceId:s.device.id,status:b.status,artifactId:result.artifactId,artifactIds,approval:b.approval??null})]);await client.query('COMMIT');worker.kick();return{ok:true,data:result};
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  });
  app.get('/api/v1/runtime/events',async(request,reply)=>{const s=await scope(request,reply);if(!s)return;const q=z.object({after:z.coerce.number().int().min(0).default(0),conversationId:z.string().uuid().optional()}).parse(request.query);return{ok:true,data:(await pool.query('SELECT sequence,conversation_id,run_id,kind,payload,created_at FROM runtime_events WHERE identity_id=$1 AND sequence>$2 AND ($3::uuid IS NULL OR conversation_id=$3) ORDER BY sequence LIMIT 200',[s.identity.id,q.after,q.conversationId??null])).rows};});
  for (const operation of ['content', 'download'] as const) app.get(`/api/v1/artifacts/:artifactId/${operation}`, async(request,reply)=>{
    const s=await scope(request,reply,operation==='download'?'export':'read');if(!s)return;
    const a=await accounts.getArtifact(s.identity.id,id((request.params as {artifactId:string}).artifactId));if(!a)throw app.httpErrors.notFound('成果不存在');
    let payload:Buffer|string=a.contentEncoding==='base64'?Buffer.from(a.content,'base64'):a.content;
    if(a.storageKey){if(!deps.objectStore)throw app.httpErrors.serviceUnavailable('对象存储未配置');const stored=await deps.objectStore.get(a.storageKey);if(!stored)throw app.httpErrors.notFound('成果对象已被清理');payload=stored;}
    return reply.header('cache-control','private, no-store').header('x-content-type-options','nosniff').header('content-disposition',`attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`).type(a.mimeType).send(payload);
  });
}
