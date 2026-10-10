import type { Pool, PoolClient } from 'pg';
import { runtimeSkillBundles, runtimeSkillCatalog, type TaskPlan } from '@kla-workstation/contracts';
import { pptAssistantRole } from './ppt-assistant.js';

export type RegisteredAgent = { id: string; name: string; role: string; model_id: string | null; model_key_id: string | null; execution_location: 'server'|'local'; device_id: string|null; enabled: boolean; version: number; skills: string[] };
export const effectiveToolCodesSql = `
  SELECT tool_code AS code FROM agent_tool_mounts WHERE agent_id=$1
  UNION
  SELECT unnest(c.tool_codes) AS code FROM agent_skill_mounts m
  JOIN agents a ON a.id=m.agent_id
  JOIN runtime_skill_catalog c ON c.identity_id=a.identity_id AND c.code=m.skill_code AND c.enabled
  WHERE m.agent_id=$1`;

export async function effectiveToolCodes(pool: Pool | PoolClient, agentId: string): Promise<string[]> {
  return (await pool.query(effectiveToolCodesSql, [agentId])).rows.map(row => row.code);
}

export async function ensureRuntimeRegistry(pool: Pool | PoolClient, identityId: string): Promise<void> {
  // Catalog entries exist independently of which agents mount them.
  await pool.query(`INSERT INTO agents(identity_id,name,role,type,execution_location) SELECT $1,v.name,v.role,'official',v.execution_location FROM
    (VALUES ('统筹智能体','理解用户目标，规划任务依赖，协调智能体和设备，汇总成果','server'),
    ('本地执行智能体','分析资料、编写文档和代码，调用技能完成完整任务','local')) v(name,role,execution_location)
    WHERE NOT EXISTS(SELECT 1 FROM agents WHERE identity_id=$1 AND name=v.name) ON CONFLICT DO NOTHING`, [identityId]);
  await pool.query(`INSERT INTO agents(identity_id,name,role,type,execution_location)
    SELECT $1,'PPT助手',$2,'official','local'
    WHERE NOT EXISTS(SELECT 1 FROM agents WHERE identity_id=$1 AND name='PPT助手') ON CONFLICT DO NOTHING`, [identityId, pptAssistantRole]);
  for (const bundle of runtimeSkillBundles) {
    await pool.query(`INSERT INTO runtime_skill_catalog(identity_id,code,name,description,tool_codes)
      VALUES($1,$2,$3,$4,$5::text[]) ON CONFLICT(identity_id,code) DO NOTHING`,
    [identityId, bundle.code, bundle.name, bundle.description, [...bundle.tools]]);
  }
  const uninitialized = await pool.query(`SELECT id FROM agents WHERE identity_id=$1 AND name='本地执行智能体' AND NOT capabilities_initialized`, [identityId]);
  for (const agent of uninitialized.rows) {
    for (const tool of runtimeSkillCatalog.filter(tool => !tool.code.startsWith('local_ppt_'))) {
      await pool.query('INSERT INTO agent_tool_mounts(agent_id,tool_code) VALUES($1,$2) ON CONFLICT DO NOTHING', [agent.id, tool.code]);
    }
    await pool.query('UPDATE agents SET capabilities_initialized=true WHERE id=$1', [agent.id]);
  }
  const pptAgents = await pool.query(`SELECT id FROM agents WHERE identity_id=$1 AND name='PPT助手' AND type='official' AND NOT capabilities_initialized`, [identityId]);
  for (const agent of pptAgents.rows) {
    for (const code of ['ppt_assistant', 'local_files', 'artifact_management', 'memory_context']) {
      await pool.query('INSERT INTO agent_skill_mounts(agent_id,skill_code) VALUES($1,$2) ON CONFLICT DO NOTHING', [agent.id, code]);
    }
    await pool.query('UPDATE agents SET capabilities_initialized=true WHERE id=$1', [agent.id]);
  }
}
export async function roomRegistry(pool: Pool, conversationId: string): Promise<RegisteredAgent[]> {
  const scope = (await pool.query('SELECT p.owner_identity_id FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=$1', [conversationId])).rows[0];
  if (!scope) throw new Error('群聊不存在');
  await ensureRuntimeRegistry(pool, scope.owner_identity_id);
  // Existing empty rooms are migrated lazily. New rooms are registered at creation.
  await pool.query(`INSERT INTO conversation_agents(conversation_id,agent_id,role)
    SELECT $1,a.id,CASE WHEN a.name='统筹智能体' THEN 'coordinator' ELSE 'member' END FROM agents a
    WHERE a.identity_id=$2 AND a.enabled AND (a.name='统筹智能体' OR NOT EXISTS(SELECT 1 FROM conversation_agents WHERE conversation_id=$1))
    ON CONFLICT DO NOTHING`, [conversationId, scope.owner_identity_id]);
  const agents = await pool.query(`SELECT a.*,COALESCE((SELECT jsonb_agg(DISTINCT x.code) FROM (
    SELECT tool_code AS code FROM agent_tool_mounts WHERE agent_id=a.id
    UNION SELECT unnest(c.tool_codes) AS code FROM agent_skill_mounts m
    JOIN runtime_skill_catalog c ON c.identity_id=a.identity_id AND c.code=m.skill_code AND c.enabled
    WHERE m.agent_id=a.id) x),'[]') AS skills
    FROM conversation_agents ca JOIN agents a ON a.id=ca.agent_id WHERE ca.conversation_id=$1 AND a.identity_id=$2 AND a.enabled ORDER BY ca.created_at,a.name`, [conversationId, scope.owner_identity_id]);
  return agents.rows;
}
export function validatePlan(plan: TaskPlan, registry: RegisteredAgent[]): void {
  const ids = new Set(registry.filter(a => a.name !== '统筹智能体').map(a => a.id));
  for (const [index, task] of plan.tasks.entries()) {
    if (!ids.has(task.agentId)) throw new Error('计划指定了群聊外或统筹智能体作为执行者');
    if (task.dependsOn.some(dep => dep >= index + 1) || new Set(task.dependsOn).size !== task.dependsOn.length) throw new Error('任务依赖必须引用前面的任务，不能循环或重复');
  }
}
