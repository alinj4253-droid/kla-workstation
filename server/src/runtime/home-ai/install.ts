import type { Pool } from 'pg';
import { ensureRuntimeRegistry } from '../registry.js';
import { requirePermission } from '../../auth/permission-service.js';
import { HOME_AI_AGENT_NAME, HOME_AI_TEMPLATE_CODE, homeAiRole } from './agent.js';
import { HomeAiError } from './service.js';

export async function installHomeAi(pool:Pool,identityId:string) {
  await requirePermission(pool,identityId,'write');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`market:${identityId}:${HOME_AI_TEMPLATE_CODE}`]);
    const existing=(await client.query('SELECT agent_id FROM agent_market_installations WHERE identity_id=$1 AND template_code=$2',[identityId,HOME_AI_TEMPLATE_CODE])).rows[0];
    if(existing){await ensureRuntimeRegistry(client,identityId);await client.query('COMMIT');return {agentId:existing.agent_id,installed:false};}
    if((await client.query('SELECT 1 FROM agents WHERE identity_id=$1 AND name=$2',[identityId,HOME_AI_AGENT_NAME])).rows[0])
      throw new HomeAiError('CONFLICT','已有同名智能体；请先改名，再从市场安装。安装不会覆盖已有角色或权限。');
    await ensureRuntimeRegistry(client,identityId);
    const agent=(await client.query(`INSERT INTO agents(identity_id,name,role,type,execution_location,capabilities_initialized)
      VALUES($1,$2,$3,'official','server',true) RETURNING id`,[identityId,HOME_AI_AGENT_NAME,homeAiRole])).rows[0];
    for(const skill of ['home_ai_diagnosis','artifact_management','weknora_research','memory_context'])
      await client.query('INSERT INTO agent_skill_mounts(agent_id,skill_code) VALUES($1,$2)',[agent.id,skill]);
    await client.query("INSERT INTO agent_tool_mounts(agent_id,tool_code) VALUES($1,'knowledge_ocr')",[agent.id]);
    await client.query('INSERT INTO agent_market_installations(identity_id,template_code,agent_id,knowledge_binding_version) VALUES($1,$2,$3,1)',[identityId,HOME_AI_TEMPLATE_CODE,agent.id]);
    // Apply the same managed default model initialization as other platform agents.
    await ensureRuntimeRegistry(client,identityId);
    await client.query('COMMIT');return {agentId:agent.id,installed:true};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
