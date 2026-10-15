import type { Pool, PoolClient } from 'pg';
import { runtimeSkillBundles, runtimeSkillCatalog, type TaskPlan } from '@kla-workstation/contracts';
import { pptAssistantRole } from './ppt-assistant.js';
import { routeAssistantRole } from './route-assistant.js';
import { wasteAssistantRole } from './waste-assistant.js';
import { homeAiRole } from './home-ai/agent.js';
import { initializeDefaultAgentModels } from './default-model.js';

export type RegisteredAgent = { id: string; name: string; role: string; conversation_role?: string; model_id: string | null; model_key_id: string | null; execution_location: 'server'|'local'; device_id: string|null; enabled: boolean; version: number; skills: string[] };
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
  await pool.query(`INSERT INTO agents(identity_id,name,role,type,execution_location)
    SELECT $1,'路线规划助手',$2,'official','local'
    WHERE NOT EXISTS(SELECT 1 FROM agents WHERE identity_id=$1 AND name='路线规划助手') ON CONFLICT DO NOTHING`, [identityId, routeAssistantRole]);
  await pool.query(`INSERT INTO agents(identity_id,name,role,type,execution_location)
    SELECT $1,'经营分析助手',$2,'official','local'
    WHERE NOT EXISTS(SELECT 1 FROM agents WHERE identity_id=$1 AND name='经营分析助手') ON CONFLICT DO NOTHING`, [identityId, wasteAssistantRole]);
  // 内置智能体 role 随代码同步升级：官方智能体的剧本以服务端定义为准（自定义 type='custom' 不受影响）
  await pool.query(`UPDATE agents a SET role=v.role FROM (VALUES
    ('统筹智能体','理解用户目标，规划任务依赖，协调智能体和设备，汇总成果'),
    ('本地执行智能体','分析资料、编写文档和代码，调用技能完成完整任务'),
    ('PPT助手',$2::text),('路线规划助手',$3::text),('经营分析助手',$4::text),('家居 AI 机会诊断',$5::text)) v(name,role)
    WHERE a.identity_id=$1 AND a.type='official' AND a.name=v.name AND a.role IS DISTINCT FROM v.role`,
  [identityId, pptAssistantRole, routeAssistantRole, wasteAssistantRole, homeAiRole]);
  for (const bundle of runtimeSkillBundles) {
    await pool.query(`INSERT INTO runtime_skill_catalog(identity_id,code,name,description,tool_codes)
      VALUES($1,$2,$3,$4,$5::text[]) ON CONFLICT(identity_id,code) DO UPDATE SET
      name=EXCLUDED.name,description=EXCLUDED.description,tool_codes=EXCLUDED.tool_codes`,
    [identityId, bundle.code, bundle.name, bundle.description, [...bundle.tools]]);
  }
  const uninitialized = await pool.query(`SELECT id FROM agents WHERE identity_id=$1 AND name='本地执行智能体' AND NOT capabilities_initialized`, [identityId]);
  for (const agent of uninitialized.rows) {
    for (const tool of runtimeSkillCatalog.filter(tool => !tool.code.startsWith('local_ppt_') && !tool.code.startsWith('home_ai_'))) {
      await pool.query('INSERT INTO agent_tool_mounts(agent_id,tool_code) VALUES($1,$2) ON CONFLICT DO NOTHING', [agent.id, tool.code]);
    }
    await pool.query('UPDATE agents SET capabilities_initialized=true WHERE id=$1', [agent.id]);
  }
  const pptAgents = await pool.query(`SELECT id FROM agents WHERE identity_id=$1 AND name='PPT助手' AND type='official' AND NOT capabilities_initialized`, [identityId]);
  for (const agent of pptAgents.rows) {
    for (const code of ['ppt_assistant', 'local_files', 'artifact_management', 'memory_context', 'knowledge_research', 'web_research']) {
      await pool.query('INSERT INTO agent_skill_mounts(agent_id,skill_code) VALUES($1,$2) ON CONFLICT DO NOTHING', [agent.id, code]);
    }
    await pool.query('UPDATE agents SET capabilities_initialized=true WHERE id=$1', [agent.id]);
  }
  const routeAgents = await pool.query(`SELECT id FROM agents WHERE identity_id=$1 AND name='路线规划助手' AND type='official' AND NOT capabilities_initialized`, [identityId]);
  for (const agent of routeAgents.rows) {
    for (const code of ['route_planning', 'local_files', 'artifact_management', 'memory_context', 'knowledge_research', 'web_research']) {
      await pool.query('INSERT INTO agent_skill_mounts(agent_id,skill_code) VALUES($1,$2) ON CONFLICT DO NOTHING', [agent.id, code]);
    }
    await pool.query('UPDATE agents SET capabilities_initialized=true WHERE id=$1', [agent.id]);
  }
  const wasteAgents = await pool.query(`SELECT id FROM agents WHERE identity_id=$1 AND name='经营分析助手' AND type='official' AND NOT capabilities_initialized`, [identityId]);
  for (const agent of wasteAgents.rows) {
    for (const code of ['waste_analysis', 'excel_analysis', 'local_files', 'artifact_management', 'memory_context', 'knowledge_research', 'web_research']) {
      await pool.query('INSERT INTO agent_skill_mounts(agent_id,skill_code) VALUES($1,$2) ON CONFLICT DO NOTHING', [agent.id, code]);
    }
    await pool.query('UPDATE agents SET capabilities_initialized=true WHERE id=$1', [agent.id]);
  }
  // 官方智能体技能增量补齐：老身份此前已 capabilities_initialized，新增技能包（如 excel_analysis）也要能挂上
  const officialAgentSkills: Record<string, string[]> = {
    'PPT助手': ['ppt_assistant', 'local_files', 'artifact_management', 'memory_context', 'knowledge_research', 'web_research'],
    '路线规划助手': ['route_planning', 'local_files', 'artifact_management', 'memory_context', 'knowledge_research', 'web_research'],
    '经营分析助手': ['waste_analysis', 'excel_analysis', 'local_files', 'artifact_management', 'memory_context', 'knowledge_research', 'web_research'],
    '家居 AI 机会诊断': ['home_ai_diagnosis', 'artifact_management', 'knowledge_research', 'memory_context'],
  };
  for (const [name, codes] of Object.entries(officialAgentSkills)) {
    await pool.query(`INSERT INTO agent_skill_mounts(agent_id,skill_code)
      SELECT a.id, v.code FROM agents a CROSS JOIN unnest($2::text[]) AS v(code)
      WHERE a.identity_id=$1 AND a.name=$3 AND a.type='official'
      ON CONFLICT DO NOTHING`, [identityId, codes, name]);
  }
  await initializeDefaultAgentModels(pool, identityId);
}
export async function roomRegistry(pool: Pool, conversationId: string): Promise<RegisteredAgent[]> {
  const scope = (await pool.query('SELECT p.owner_identity_id FROM conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=$1', [conversationId])).rows[0];
  if (!scope) throw new Error('群聊不存在');
  await ensureRuntimeRegistry(pool, scope.owner_identity_id);
  // Existing empty rooms are migrated lazily, but only the mandatory room
  // coordinator is added. Other agents must be explicitly selected when the
  // room is created or added through the room-agent management endpoint.
  // Never infer the whole identity agent catalog as a room member: the room
  // membership table is the authoritative execution pool.
  await pool.query(`INSERT INTO conversation_agents(conversation_id,agent_id,role)
    SELECT $1,a.id,CASE WHEN a.name IN ('群聊秘书','统筹智能体') THEN 'coordinator' ELSE 'member' END FROM agents a
    WHERE a.identity_id=$2 AND a.enabled AND a.name IN ('群聊秘书','统筹智能体')
    ON CONFLICT DO NOTHING`, [conversationId, scope.owner_identity_id]);
  const agents = await pool.query(`SELECT a.*,COALESCE((SELECT jsonb_agg(DISTINCT x.code) FROM (
    SELECT tool_code AS code FROM agent_tool_mounts WHERE agent_id=a.id
    UNION SELECT unnest(c.tool_codes) AS code FROM agent_skill_mounts m
    JOIN runtime_skill_catalog c ON c.identity_id=a.identity_id AND c.code=m.skill_code AND c.enabled
    WHERE m.agent_id=a.id) x),'[]') AS skills
    FROM conversation_agents ca JOIN agents a ON a.id=ca.agent_id WHERE ca.conversation_id=$1 AND a.identity_id=$2 AND a.enabled ORDER BY ca.created_at,a.name`, [conversationId, scope.owner_identity_id]);
  for (const row of agents.rows) row.conversation_role = (await pool.query('SELECT role FROM conversation_agents WHERE conversation_id=$1 AND agent_id=$2',[conversationId,row.id])).rows[0]?.role ?? 'member';
  return agents.rows;
}
export function validatePlan(plan: TaskPlan, registry: RegisteredAgent[]): void {
  const ids = new Set(registry.filter(a => a.conversation_role !== 'coordinator' && a.name !== '群聊秘书' && a.name !== '统筹智能体').map(a => a.id));
  for (const [index, task] of plan.tasks.entries()) {
    if (!ids.has(task.agentId)) throw new Error('计划指定了群聊外或统筹智能体作为执行者');
    if (task.dependsOn.some(dep => dep >= index + 1) || new Set(task.dependsOn).size !== task.dependsOn.length) throw new Error('任务依赖必须引用前面的任务，不能循环或重复');
  }
}
